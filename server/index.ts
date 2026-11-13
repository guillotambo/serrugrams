// Servidor local: sirve la UI, la API de archivos y los eventos en vivo. Uno solo para todas las referencias
// de la vista (ver docs/referencias.md y server/refs.ts).
// Uso: node server/index.ts [rutas a agregar…] [--port 4747] [--workspace archivo.json] [--dev]
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WorkspaceError } from "./workspace.ts";
import { Refs, completePath } from "./refs.ts";
import { emptyDiagram, refIdOf, type ServerEvent } from "../shared/types.ts";

const args = process.argv.slice(2);
function flag(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
const VALUE_FLAGS = ["--port", "--workspace", "--root"];
const dev = args.includes("--dev");
const positional = args.filter((a, i) => !a.startsWith("--") && !VALUE_FLAGS.includes(args[i - 1] ?? ""));
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const home = process.env.SERRUGRAMS_HOME ? path.resolve(process.env.SERRUGRAMS_HOME) : path.join(os.homedir(), ".serrugrams");
// En desarrollo, una vista aparte con los ejemplos y otro puerto, para no chocar con el servidor de todos los días.
const workspaceFile = path.resolve(flag("--workspace") ?? (dev ? path.join(repoRoot, ".serrugrams", "workspace.dev.json") : path.join(home, "workspace.json")));
const port = Number(flag("--port") ?? process.env.SERRUGRAMS_PORT ?? (dev ? 4848 : 4747));
const toAdd = [...positional, ...(flag("--root") ? [flag("--root")!] : []), ...(dev ? [path.join(repoRoot, "examples")] : [])];
// La UI construida: junto al servidor compilado (dist/server -> dist/ui) o, corriendo el fuente, en dist/ui del repo.
const distDir = [path.join(here, "..", "ui"), path.join(here, "..", "dist", "ui")].find((d) => existsSync(path.join(d, "index.html"))) ?? path.join(here, "..", "dist", "ui");

// --- Eventos en vivo ---
type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
function broadcast(e: ServerEvent) {
  for (const l of listeners) l(e);
}

const refs = new Refs(workspaceFile, broadcast);
await refs.start();
for (const p of toAdd) {
  try {
    await refs.add(p);
  } catch (err) {
    console.error(`No se pudo agregar ${p}: ${err instanceof Error ? err.message : err}`);
  }
}

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

// --- Vista ---
app.get("/api/tree", async (c) => c.json(await refs.tree()));

app.post("/api/refs", async (c) => {
  const body = await c.req.json();
  return c.json({ ref: await refs.add(body.path, body.id) });
});

app.patch("/api/refs", async (c) => {
  const body = await c.req.json();
  return c.json({ id: await refs.rename(body.id, body.next) });
});

app.delete("/api/refs", async (c) => {
  await refs.remove(q(c, "id"));
  return c.json({ ok: true });
});

app.get("/api/complete", async (c) => c.json({ items: await completePath(c.req.query("prefix") ?? "") }));

// --- Diagramas (rutas globales: `<referencia>/<ruta>`) ---
app.get("/api/file", async (c) => {
  const p = q(c, "path");
  const { ws, rel } = refs.locate(p);
  const { content, hash } = await ws.readDiagram(rel);
  return c.json({ path: p, content, hash });
});

app.put("/api/file", async (c) => {
  const { ws, rel } = refs.locate(q(c, "path"));
  const body = await c.req.json();
  const hash = await ws.writeDiagram(rel, body.content, { baseHash: body.baseHash });
  return c.json({ hash });
});

app.post("/api/file", async (c) => {
  const body = await c.req.json();
  const { ws, rel } = refs.locate(body.path);
  const hash = await ws.writeDiagram(rel, body.content ?? emptyDiagram(), { mustNotExist: true });
  if (body.comments) await ws.writeComments(rel, body.comments);
  return c.json({ hash });
});

app.delete("/api/entry", async (c) => {
  const { ws, rel } = refs.locate(q(c, "path"));
  await ws.trash(rel);
  return c.json({ ok: true });
});

app.post("/api/rename", async (c) => {
  const body = await c.req.json();
  if (refIdOf(body.from ?? "") !== refIdOf(body.to ?? "")) throw new WorkspaceError(400, "No se puede mover entre referencias distintas");
  const from = refs.locate(body.from);
  const to = refs.locate(body.to);
  await from.ws.rename(from.rel, to.rel);
  await refs.moved(from.ws.resolve(from.rel), to.ws.resolve(to.rel));
  return c.json({ ok: true });
});

app.post("/api/dir", async (c) => {
  const body = await c.req.json();
  const { ws, rel } = refs.locate(body.path);
  await ws.mkdir(rel);
  broadcast({ type: "tree" });
  return c.json({ ok: true });
});

app.get("/api/comments", async (c) => {
  const { ws, rel } = refs.locate(q(c, "path"));
  return c.json(await ws.readComments(rel));
});

app.put("/api/comments", async (c) => {
  const { ws, rel } = refs.locate(q(c, "path"));
  await ws.writeComments(rel, await c.req.json());
  return c.json({ ok: true });
});

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
  console.log(`Serrugrams · vista: ${workspaceFile}`);
  for (const r of refs.info()) console.log(`  ${r.id}: ${r.path}${r.missing ? " (no se encuentra)" : ""}`);
  console.log(dev ? `API en http://127.0.0.1:${port} (UI en http://localhost:5173)` : `Abrí http://localhost:${port}`);
});
