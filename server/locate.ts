// Ubicar en disco lo que se suelta desde Finder. El navegador no da la ruta de lo soltado, pero sí el nombre, el tamaño
// y la fecha de modificación de un archivo, o el nombre y el contenido de una carpeta. Con eso se busca en Spotlight
// (mdfind) y se quedan los que coinciden exactamente. Puede haber más de uno (por ejemplo, dos checkouts del mismo repo):
// la UI hace elegir. Solo en macOS, como el selector (server/picker.ts).
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceError } from "./workspace.ts";
import type { Dropped } from "../shared/types.ts";

export const locateAvailable = process.platform === "darwin";

export type { Dropped };

/** Tantos hijos como devuelve el navegador de una vez; con menos, la carpeta tiene que tener exactamente esos. */
const CHILDREN_BATCH = 100;
const MAX = 20;

function mdfind(d: Dropped): Promise<string[]> {
  const name = d.name.replace(/["\\*]/g, "\\$&");
  const query = `kMDItemFSName == "${name}"` + (d.kind === "dir" ? ` && kMDItemContentType == "public.folder"` : "");
  return new Promise((resolve, reject) => {
    execFile("mdfind", [query], { timeout: 8000, maxBuffer: 4 << 20 }, (err, stdout) => {
      if (err) return reject(new WorkspaceError(500, "No se pudo buscar en Spotlight"));
      resolve(stdout.split("\n").filter(Boolean));
    });
  });
}

/** Si la ruta es lo que se soltó: mismo tamaño y fecha (archivo) o mismo contenido (carpeta). */
export async function matches(p: string, d: Dropped): Promise<boolean> {
  try {
    if (path.basename(p) !== d.name) return false;
    const st = await fs.stat(p);
    if (d.kind === "file") return st.isFile() && st.size === d.size && Math.abs(st.mtimeMs - d.mtime) < 2000;
    if (!st.isDirectory()) return false;
    const names = new Set(await fs.readdir(p));
    if (!d.children.every((c) => names.has(c))) return false;
    return d.children.length >= CHILDREN_BATCH || names.size === d.children.length;
  } catch {
    return false;
  }
}

const skipped = (p: string) => p.startsWith(path.join(os.homedir(), ".Trash") + path.sep) || p.split(path.sep).includes("node_modules");

/** Rutas absolutas que coinciden con lo soltado. `find` se cambia en los tests. */
export async function locate(d: Dropped, find: (d: Dropped) => Promise<string[]> = mdfind): Promise<string[]> {
  if (!d || (d.kind !== "file" && d.kind !== "dir") || typeof d.name !== "string" || !d.name || d.name.includes("/")) {
    throw new WorkspaceError(400, "Falta qué se soltó");
  }
  if (d.kind === "dir" && !Array.isArray(d.children)) throw new WorkspaceError(400, "Falta el contenido de la carpeta");
  if (!locateAvailable && find === mdfind) throw new WorkspaceError(501, "Solo está disponible en macOS");
  const found: string[] = [];
  for (const p of await find(d)) {
    if (skipped(p) || !(await matches(p, d))) continue;
    found.push(p);
    if (found.length >= MAX) break;
  }
  return found.sort();
}
