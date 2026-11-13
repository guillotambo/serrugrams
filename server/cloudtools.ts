// Herramientas del modo nube (docs/nube.md):
//   serrugrams cloud build [--out serrugrams-cloud]   arma la salida para `vercel deploy --prebuilt`
//   serrugrams cloud local --root <carpeta> [--password x] [--port 4950]
//                                                     la nube en tu máquina, sobre una carpeta, para probar
// `build` necesita el repo clonado (empaqueta server/vercel.ts con Vite); `local` corre también desde el paquete.
import { serve } from "@hono/node-server";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { cloudApp } from "./cloud.ts";
import { defaultUiDir } from "./site.ts";
import { DiskStore } from "./store.ts";
import { Workspace } from "./workspace.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CLOUD_META = '<meta name="serrugrams-cloud" content="1" />';
const MARKER = ".serrugrams-cloud";

const withCloudMeta = (html: string) => html.replace(/<head>/i, `<head>\n    ${CLOUD_META}\n    <meta name="robots" content="noindex" />`);

/** Arma `<out>/.vercel/output` (Build Output API de Vercel): la UI estática y una función con toda la API. */
export async function buildCloud(outArg: string): Promise<string> {
  const out = path.resolve(outArg);
  const uiDir = defaultUiDir();
  if (!uiDir) throw new Error("No hay build de la UI. Corré `pnpm build` primero.");
  const entry = path.join(here, "vercel.ts");
  if (!existsSync(entry)) throw new Error("`cloud build` corre desde el repo clonado de Serrugrams (necesita server/vercel.ts).");

  // Se rehace todo menos el vínculo con el proyecto de Vercel (.vercel/project.json).
  await fs.mkdir(out, { recursive: true });
  const items = await fs.readdir(out);
  if (items.length && !items.includes(MARKER)) throw new Error(`${out} ya existe y no es una salida de \`serrugrams cloud build\`.`);
  await fs.rm(path.join(out, ".vercel", "output"), { recursive: true, force: true });
  const output = path.join(out, ".vercel", "output");
  const staticDir = path.join(output, "static");
  const funcDir = path.join(output, "functions", "api.func");

  await fs.cp(uiDir, staticDir, { recursive: true });
  const index = path.join(staticDir, "index.html");
  await fs.writeFile(index, withCloudMeta(await fs.readFile(index, "utf8")));

  // Un solo archivo con todo adentro (Hono, el SDK de Blob, el Workspace): la función no instala nada.
  const { build } = await import("vite");
  await build({
    configFile: false,
    logLevel: "warn",
    publicDir: false, // public/ (fuentes, favicon) es de la UI, no de la función
    build: {
      ssr: entry,
      outDir: funcDir,
      emptyOutDir: true,
      target: "node22",
      minify: false,
      rollupOptions: {
        output: {
          entryFileNames: "index.mjs",
          format: "es",
          // Algunas dependencias son CommonJS y piden módulos de Node con require.
          banner: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);',
        },
      },
    },
    ssr: { noExternal: true, target: "node" },
  });
  await fs.writeFile(path.join(funcDir, ".vc-config.json"), JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false }, null, 2));
  await fs.writeFile(
    path.join(output, "config.json"),
    JSON.stringify({ version: 3, routes: [{ handle: "filesystem" }, { src: "^/api(/.*)?$", dest: "/api" }] }, null, 2),
  );
  await fs.writeFile(path.join(out, MARKER), "Generado por `serrugrams cloud build`. Se rehace en cada corrida.\n");
  return out;
}

/** La nube en tu máquina: la misma API y la misma UI, sobre una carpeta del disco en vez de Blob. */
export async function serveCloudLocal(opts: { root: string; password: string; port: number }): Promise<void> {
  const uiDir = defaultUiDir();
  if (!uiDir) throw new Error("No hay build de la UI. Corré `pnpm build` primero.");
  const app = new Hono();
  app.route("/", cloudApp({ ws: new Workspace(new DiskStore(opts.root)), password: opts.password, secure: false }));
  const html = withCloudMeta(await fs.readFile(path.join(uiDir, "index.html"), "utf8"));
  app.get("/", (c) => c.html(html));
  app.get("/index.html", (c) => c.html(html));
  app.get("/*", async (c) => {
    const file = path.join(uiDir, path.normalize(decodeURIComponent(c.req.path)));
    if (!file.startsWith(uiDir + path.sep)) return c.notFound();
    try {
      const data = await fs.readFile(file);
      const type = { ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".png": "image/png" }[path.extname(file)] ?? "application/octet-stream";
      return c.body(data, 200, { "content-type": type });
    } catch {
      return c.notFound();
    }
  });
  serve({ fetch: app.fetch, port: opts.port, hostname: "127.0.0.1" }, () => {
    console.log(`Serrugrams nube (local) sobre ${path.resolve(opts.root)} · http://localhost:${opts.port}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...args] = process.argv.slice(2);
  const flag = (name: string, fallback?: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : fallback;
  };
  try {
    if (cmd === "build") {
      const out = await buildCloud(flag("--out", "serrugrams-cloud")!);
      const shown = path.relative(process.cwd(), out) || ".";
      console.log(`Listo en ${shown}. Para subirlo: cd ${shown} && vercel deploy --prebuilt --prod`);
    } else if (cmd === "local") {
      const root = flag("--root");
      if (!root) throw new Error("Falta --root <carpeta>");
      await serveCloudLocal({ root, password: flag("--password", process.env.SERRUGRAMS_PASSWORD ?? "")!, port: Number(flag("--port", "4950")) });
    } else {
      throw new Error("Uso: serrugrams cloud build [--out carpeta] | serrugrams cloud local --root <carpeta> [--password x] [--port 4950]");
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
