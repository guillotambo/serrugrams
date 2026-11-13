// Sitio estático de solo lectura: la misma interfaz, sin servidor, para publicar diagramas (Vercel o cualquier
// hosting de archivos). Toma rutas explícitas, no la vista de ~/.serrugrams. Ver docs/sitio.md.
//
// Salida:
//   index.html, assets/, fonts/…     la UI de dist/ui, con <meta name="serrugrams-site"> (la pone en solo lectura)
//   data/tree.json                   el árbol, sin rutas absolutas del disco
//   data/files/<ruta global>         cada diagrama (y, con --comments, su .comments.json al lado)
//
// Uso: node server/site.ts <carpetas o diagramas…> [--out serrugrams-site] [--comments]
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMMENTS_SUFFIX, type RefInfo, type RelPath, type TreeEntry, type TreeResponse } from "../shared/types.ts";
import { Refs } from "./refs.ts";

/** Archivo que marca una carpeta como salida de este comando: solo esas se pueden reescribir. */
export const SITE_MARKER = ".serrugrams-site";
/** La UI se pone en modo sitio con esta etiqueta; "comments" le dice que hay comentarios publicados para pedir. */
export const siteMeta = (comments: boolean) => `<meta name="serrugrams-site" content="${comments ? "comments" : "1"}" />`;

export interface SiteOptions {
  inputs: string[];
  out: string;
  /** Publicar también los comentarios. Por defecto no: suelen ser notas de revisión con nombres. */
  comments?: boolean;
  /** Carpeta con la UI construida (index.html). Por defecto, la de `pnpm build`. */
  uiDir?: string;
}

export interface SiteResult {
  out: string;
  refs: string[];
  diagrams: number;
  /** Diagramas que no están en la vista pero se publican porque algo linkea a ellos. */
  linked: number;
  comments: number;
}

const here = path.dirname(fileURLToPath(import.meta.url));

export function defaultUiDir(): string | undefined {
  return [path.join(here, "..", "ui"), path.join(here, "..", "dist", "ui")].find((d) => existsSync(path.join(d, "index.html")));
}

export async function buildSite(opts: SiteOptions): Promise<SiteResult> {
  if (!opts.inputs.length) throw new Error("Faltan las carpetas o diagramas a publicar");
  const uiDir = opts.uiDir ?? defaultUiDir();
  if (!uiDir || !existsSync(path.join(uiDir, "index.html"))) throw new Error("No hay build de la UI. Corré `pnpm build` primero.");
  const out = path.resolve(opts.out);
  await prepareOut(out);

  // Una vista descartable: no se toca ~/.serrugrams/workspace.json.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "serrugrams-site-"));
  const refs = new Refs(path.join(scratch, "workspace.json"), () => {});
  try {
    for (const input of opts.inputs) await refs.add(input);
    const tree = await refs.tree();
    const entries = publishable(tree.entries);
    const files = entries.filter((e) => e.type === "file");

    await fs.cp(uiDir, out, { recursive: true });
    const indexPath = path.join(out, "index.html");
    const html = await fs.readFile(indexPath, "utf8");
    await fs.writeFile(indexPath, html.replace(/<head>/i, `<head>\n    ${siteMeta(!!opts.comments)}\n    <meta name="robots" content="noindex" />`));

    let comments = 0;
    for (const e of files) {
      const { ws, rel } = refs.locate(e.path);
      const { content } = await ws.readDiagram(rel);
      const dest = path.join(out, "data", "files", ...e.path.split("/"));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, JSON.stringify(content));
      if (opts.comments) {
        // Uno por diagrama, aunque esté vacío: así la UI nunca pide un archivo que no existe.
        const c = await ws.readComments(rel);
        await fs.writeFile(dest + COMMENTS_SUFFIX, JSON.stringify(c));
        comments += c.comments.length;
      }
    }

    const published: TreeResponse = {
      refs: tree.refs.map(sanitizeRef),
      entries: opts.comments ? entries : entries.map(({ openComments, ...e }) => e),
    };
    await fs.writeFile(path.join(out, "data", "tree.json"), JSON.stringify(published));
    await fs.writeFile(path.join(out, SITE_MARKER), "Generado por `serrugrams site`. Se reescribe entero en cada corrida.\n");

    return {
      out,
      refs: tree.refs.map((r) => r.id),
      diagrams: files.length,
      linked: files.filter((e) => e.hidden).length,
      comments,
    };
  } finally {
    await refs.close();
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Lo que se publica: lo visible en la vista, más los diagramas escondidos (los demás del repo de un diagrama suelto)
 * solo si se llega a ellos siguiendo links. Un diagrama suelto no publica el repo entero.
 */
export function publishable(entries: TreeEntry[]): TreeEntry[] {
  const byPath = new Map(entries.map((e) => [e.path, e]));
  const keep = new Set(entries.filter((e) => !e.hidden).map((e) => e.path));
  const queue = [...keep];
  while (queue.length) {
    for (const target of byPath.get(queue.pop()!)?.links ?? []) {
      if (keep.has(target) || byPath.get(target)?.type !== "file") continue;
      keep.add(target);
      queue.push(target);
    }
  }
  return entries.filter((e) => keep.has(e.path));
}

/** Sin rutas absolutas: no se publica dónde está cada repo en tu disco. */
function sanitizeRef(r: RefInfo): RefInfo {
  return { id: r.id, kind: r.kind, path: r.id, root: path.basename(r.root), ...(r.file ? { file: r.file } : {}), ...(r.missing ? { missing: true } : {}) };
}

/** La carpeta de salida tiene que no existir, estar vacía o ser una salida anterior (que se borra entera). */
async function prepareOut(out: string): Promise<void> {
  let items: string[];
  try {
    items = await fs.readdir(out);
  } catch {
    await fs.mkdir(out, { recursive: true });
    return;
  }
  if (items.length === 0) return;
  if (!items.includes(SITE_MARKER)) throw new Error(`${out} ya existe y no es un sitio de Serrugrams. Elegí otra carpeta con --out.`);
  for (const item of items) if (item !== ".vercel") await fs.rm(path.join(out, item), { recursive: true, force: true });
}

function parseArgs(args: string[]): SiteOptions {
  const inputs: RelPath[] = [];
  let out = "serrugrams-site";
  let comments = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out") out = args[++i] ?? out;
    else if (a.startsWith("--out=")) out = a.slice(6);
    else if (a === "--comments") comments = true;
    else if (a.startsWith("-")) throw new Error(`Opción desconocida: ${a}`);
    else inputs.push(a);
  }
  return { inputs, out, comments };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = await buildSite(parseArgs(process.argv.slice(2)));
    const rel = path.relative(process.cwd(), r.out);
    const shown = !rel ? "." : rel.startsWith("..") ? r.out : rel;
    const extra = [r.linked ? `${r.linked} por links` : "", r.comments ? `${r.comments} comentarios` : "sin comentarios"].filter(Boolean).join(", ");
    console.log(`Sitio en ${shown}: ${r.diagrams} diagramas de ${r.refs.join(", ")} (${extra}).`);
    console.log(`Para verlo: npx serve ${shown}   ·   Para publicarlo: npx vercel deploy ${shown}`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
