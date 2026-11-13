// Servidor local: sirve la UI, la API de archivos y los eventos en vivo.
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import chokidar from "chokidar";
import path from "node:path";
import { existsSync, promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { Workspace, WorkspaceError, hashOf } from "./workspace.ts";
import { COMMENTS_SUFFIX, DIAGRAM_EXT, emptyDiagram, type ServerEvent } from "../shared/types.ts";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const dev = args.includes("--dev");
const positional = args.filter((a, i) => !a.startsWith("--") && !["--port", "--root"].includes(args[i - 1] ?? ""));
const root = path.resolve(flag("--root") ?? positional[0] ?? process.env.SERRUGRAMS_ROOT ?? (dev ? "examples" : process.cwd()));
const port = Number(flag("--port") ?? process.env.SERRUGRAMS_PORT ?? 4747);
const here = path.dirname(fileURLToPath(import.meta.url));
// La UI construida: junto al servidor compilado (dist/server -> dist/ui) o, corriendo el fuente, en dist/ui del repo.
const distDir = [path.join(here, "..", "ui"), path.join(here, "..", "dist", "ui")].find((d) => existsSync(path.join(d, "index.html"))) ?? path.join(here, "..", "dist", "ui");

await fs.mkdir(root, { recursive: true });
const ws = new Workspace(root);
const app = new Hono();

// --- Seguridad: solo localhost, y las escrituras solo desde nuestra propia página. ---
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
app.use("*", async (c, next) => {
  const host = c.req.header("host") ?? "";
  if (!LOCAL_HOST.test(host)) return c.text("Host no permitido", 403);
  const origin = c.req.header("origin");
  if (origin) {
    let ok = false;
    try {
      ok = LOCAL_HOST.test(new URL(origin).host);
    } catch {}
    if (!ok) return c.text("Origen no permitido", 403);
  }
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    // Un formulario de otra web no puede mandar JSON sin preflight; lo exigimos.
    if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.text("Se requiere JSON", 415);
  }
  await next();
});

app.onError((err, c) => {
  if (err instanceof WorkspaceError) return c.json({ error: err.message }, err.status as any);
  console.error(err);
  return c.json({ error: "Error interno" }, 500);
});

const q = (c: any, name: string): string => {
  const v = c.req.query(name);
  if (!v) throw new WorkspaceError(400, `Falta el parámetro ${name}`);
  return v;
};

app.get("/api/tree", async (c) => c.json({ rootName: ws.rootName, rootPath: ws.root, entries: await ws.tree() }));

app.get("/api/file", async (c) => {
  const p = q(c, "path");
  const { content, hash } = await ws.readDiagram(p);
  return c.json({ path: p, content, hash });
});

app.put("/api/file", async (c) => {
  const p = q(c, "path");
  const body = await c.req.json();
  const hash = await ws.writeDiagram(p, body.content, { baseHash: body.baseHash });
  return c.json({ hash });
});

app.post("/api/file", async (c) => {
  const body = await c.req.json();
  const hash = await ws.writeDiagram(body.path, body.content ?? emptyDiagram(), { mustNotExist: true });
  if (body.comments) await ws.writeComments(body.path, body.comments);
  return c.json({ hash });
});

app.delete("/api/entry", async (c) => {
  await ws.trash(q(c, "path"));
  return c.json({ ok: true });
});

app.post("/api/rename", async (c) => {
  const body = await c.req.json();
  await ws.rename(body.from, body.to);
  return c.json({ ok: true });
});

app.post("/api/dir", async (c) => {
  const body = await c.req.json();
  await ws.mkdir(body.path);
  broadcast({ type: "tree" });
  return c.json({ ok: true });
});

app.get("/api/comments", async (c) => c.json(await ws.readComments(q(c, "path"))));

app.put("/api/comments", async (c) => {
  const p = q(c, "path");
  await ws.writeComments(p, await c.req.json());
  return c.json({ ok: true });
});

// --- Eventos en vivo (SSE) ---
type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
function broadcast(e: ServerEvent) {
  for (const l of listeners) l(e);
}

app.get("/api/events", (c) =>
  streamSSE(c, async (stream) => {
    const queue: ServerEvent[] = [];
    let wake: (() => void) | null = null;
    const listener: Listener = (e) => {
      queue.push(e);
      wake?.();
    };
    listeners.add(listener);
    stream.onAbort(() => {
      listeners.delete(listener);
      wake?.();
    });
    await stream.writeSSE({ data: JSON.stringify({ type: "hello" }) });
    while (!stream.aborted) {
      while (queue.length) await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 25000);
      });
      wake = null;
      if (!stream.aborted && queue.length === 0) await stream.writeSSE({ event: "ping", data: "" });
    }
  }),
);

// --- Observador de la carpeta: el disco es la fuente de verdad. ---
let treeTimer: NodeJS.Timeout | null = null;
function treeChanged() {
  if (treeTimer) clearTimeout(treeTimer);
  treeTimer = setTimeout(() => broadcast({ type: "tree" }), 80);
}
const watcher = chokidar.watch(root, {
  ignoreInitial: true,
  ignored: (p, stats) => {
    const base = path.basename(p);
    if (p !== root && (base === "node_modules" || base === "dist" || base.startsWith("."))) return true;
    if (stats?.isFile()) return !(p.endsWith(DIAGRAM_EXT) || p.endsWith(DIAGRAM_EXT + COMMENTS_SUFFIX));
    return false;
  },
});
async function onFile(abs: string, kind: "add" | "change" | "unlink") {
  const rel = ws.toRel(abs);
  if (rel.endsWith(COMMENTS_SUFFIX)) {
    broadcast({ type: "comments", path: rel.slice(0, -COMMENTS_SUFFIX.length) });
    treeChanged();
    return;
  }
  if (kind === "change" || kind === "add") {
    try {
      broadcast({ type: "file", path: rel, hash: hashOf(await fs.readFile(abs, "utf8")) });
    } catch {}
  }
  treeChanged();
}
watcher
  .on("add", (p) => onFile(p, "add"))
  .on("change", (p) => onFile(p, "change"))
  .on("unlink", (p) => onFile(p, "unlink"))
  .on("addDir", treeChanged)
  .on("unlinkDir", treeChanged);

// --- UI estática (build de producción) ---
if (!dev) {
  if (!existsSync(path.join(distDir, "index.html"))) {
    console.error("No hay build de la UI. Corré `pnpm build` primero (o `pnpm dev` para desarrollo).");
    process.exit(1);
  }
  const rootRel = path.relative(process.cwd(), distDir) || ".";
  app.use("/*", serveStatic({ root: rootRel }));
  app.get("*", serveStatic({ root: rootRel, path: "index.html" }));
}

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, () => {
  console.log(`Serrugrams · carpeta: ${root}`);
  console.log(dev ? `API en http://127.0.0.1:${port} (UI en http://localhost:5173)` : `Abrí http://localhost:${port}`);
});
