// Dónde viven los archivos de un Workspace: el disco (modo local, el de siempre) o un depósito de claves planas
// como Vercel Blob (modo nube). Workspace (server/workspace.ts) pone las reglas; un Store solo guarda y lee texto.
//
// Las rutas son relativas a la raíz del store, POSIX, sin "/" inicial, y ya vienen validadas por Workspace.
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { DIAGRAM_EXT, type RelPath } from "../shared/types.ts";

/** Carpetas que nunca se listan ni se pueden pedir. `.serrugrams` guarda la papelera. */
export const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".serrugrams", ".next", "target", "vendor"]);

export interface Listing {
  /** Diagramas, con una versión que cambia cuando cambia el archivo (para cachear lo que se lee de ellos). */
  files: { path: RelPath; version: string }[];
  /** Carpetas que se pueden mostrar, y si están vacías. */
  dirs: { path: RelPath; empty: boolean }[];
}

export interface Store {
  /** Nombre para mostrar: la ruta absoluta en disco, o algo como "vercel-blob:diagramas". */
  readonly label: string;
  list(): Promise<Listing>;
  /** El texto del archivo, o null si no existe. */
  read(rel: RelPath): Promise<string | null>;
  /** Crea o reemplaza el archivo entero (y las carpetas que hagan falta). */
  write(rel: RelPath, text: string): Promise<void>;
  /** Borra un archivo; si no existe, no pasa nada. */
  remove(rel: RelPath): Promise<void>;
  kind(rel: RelPath): Promise<"file" | "dir" | null>;
  mkdir(rel: RelPath): Promise<void>;
  /** Mueve un archivo o una carpeta con todo lo de adentro. El destino no existe (lo chequea Workspace). */
  move(from: RelPath, to: RelPath): Promise<void>;
}

const hidden = (name: string) => IGNORED_DIRS.has(name) || name.startsWith(".");

// ---------- Disco ----------

export class DiskStore implements Store {
  readonly root: string;
  constructor(root: string) {
    this.root = path.resolve(root);
  }
  get label() {
    return this.root;
  }

  abs(rel: RelPath): string {
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new Error("La ruta sale del workspace");
    return abs;
  }

  async list(): Promise<Listing> {
    const out: Listing = { files: [], dirs: [] };
    const walk = async (dir: string) => {
      let items: import("node:fs").Dirent[];
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        const abs = path.join(dir, item.name);
        const rel = path.relative(this.root, abs).split(path.sep).join("/");
        if (item.isDirectory()) {
          if (hidden(item.name)) continue;
          let empty = false;
          try {
            empty = (await fs.readdir(abs)).length === 0;
          } catch {}
          out.dirs.push({ path: rel, empty });
          await walk(abs);
        } else if (item.isFile() && item.name.endsWith(DIAGRAM_EXT)) {
          let version = "";
          try {
            version = String((await fs.stat(abs)).mtimeMs);
          } catch {}
          out.files.push({ path: rel, version });
        }
      }
    };
    await walk(this.root);
    return out;
  }

  async read(rel: RelPath): Promise<string | null> {
    try {
      return await fs.readFile(this.abs(rel), "utf8");
    } catch {
      return null;
    }
  }

  /** Atómico: se escribe al lado y se renombra, así nadie lee un archivo a medias. */
  async write(rel: RelPath, text: string): Promise<void> {
    const abs = this.abs(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(4).toString("hex")}.tmp`);
    await fs.writeFile(tmp, text, "utf8");
    await fs.rename(tmp, abs);
  }

  async remove(rel: RelPath): Promise<void> {
    await fs.rm(this.abs(rel), { force: true });
  }

  async kind(rel: RelPath): Promise<"file" | "dir" | null> {
    try {
      const st = await fs.stat(this.abs(rel));
      return st.isDirectory() ? "dir" : st.isFile() ? "file" : null;
    } catch {
      return null;
    }
  }

  async mkdir(rel: RelPath): Promise<void> {
    await fs.mkdir(this.abs(rel), { recursive: true });
  }

  async move(from: RelPath, to: RelPath): Promise<void> {
    const dst = this.abs(to);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(this.abs(from), dst);
  }
}

// ---------- Claves planas (Vercel Blob, memoria) ----------

/** Marca de carpeta: en un depósito de claves planas una carpeta solo existe si algo vive adentro. */
export const DIR_MARKER = ".keep";

/**
 * Base para depósitos sin carpetas de verdad: las carpetas salen de las claves ("a/b/c.excalidraw" implica "a" y
 * "a/b"), y una carpeta vacía es una clave "<carpeta>/.keep". Las subclases implementan solo las primitivas.
 */
export abstract class FlatStore implements Store {
  abstract readonly label: string;
  /** Todas las claves, con su versión. */
  protected abstract keys(): Promise<{ key: RelPath; version: string }[]>;
  protected abstract get(key: RelPath): Promise<string | null>;
  protected abstract put(key: RelPath, text: string): Promise<void>;
  protected abstract del(keys: RelPath[]): Promise<void>;
  /** Copia del lado del depósito si se puede; por defecto, leer y escribir. */
  protected async copy(from: RelPath, to: RelPath): Promise<void> {
    const text = await this.get(from);
    if (text !== null) await this.put(to, text);
  }

  async list(): Promise<Listing> {
    const all = await this.keys();
    const visible = all.filter(({ key }) => !key.split("/").slice(0, -1).some(hidden));
    const files = visible.filter(({ key }) => key.endsWith(DIAGRAM_EXT) && !path.posix.basename(key).startsWith(".")).map(({ key, version }) => ({ path: key, version }));
    const dirs = new Map<RelPath, boolean>(); // carpeta → vacía
    for (const { key } of visible) {
      const parts = key.split("/");
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join("/");
        const isOwnMarker = i === parts.length - 1 && parts[i] === DIR_MARKER;
        dirs.set(dir, (dirs.get(dir) ?? true) && isOwnMarker);
      }
    }
    return { files, dirs: [...dirs].map(([p, empty]) => ({ path: p, empty })) };
  }

  read(rel: RelPath) {
    return this.get(rel);
  }

  async write(rel: RelPath, text: string): Promise<void> {
    await this.put(rel, text);
    // La carpeta ya no está vacía: su marca sobra.
    const dir = path.posix.dirname(rel);
    if (dir !== ".") await this.del([`${dir}/${DIR_MARKER}`]).catch(() => {});
  }

  async remove(rel: RelPath): Promise<void> {
    await this.del([rel]);
  }

  async kind(rel: RelPath): Promise<"file" | "dir" | null> {
    const all = await this.keys();
    if (all.some(({ key }) => key === rel)) return "file";
    if (all.some(({ key }) => key.startsWith(rel + "/"))) return "dir";
    return null;
  }

  async mkdir(rel: RelPath): Promise<void> {
    // Con algo adentro: Vercel Blob no acepta archivos vacíos.
    if ((await this.kind(rel)) === null) await this.put(`${rel}/${DIR_MARKER}`, "carpeta\n");
  }

  async move(from: RelPath, to: RelPath): Promise<void> {
    const all = await this.keys();
    const moving = all.filter(({ key }) => key === from || key.startsWith(from + "/")).map(({ key }) => key);
    for (const key of moving) await this.copy(key, to + key.slice(from.length));
    await this.del(moving);
  }
}

/** En memoria: para tests, y para probar el modo nube sin Vercel. */
export class MemoryStore extends FlatStore {
  readonly label = "memoria";
  private data = new Map<RelPath, { text: string; version: number }>();
  private counter = 0;
  protected async keys() {
    return [...this.data].map(([key, v]) => ({ key, version: String(v.version) }));
  }
  protected async get(key: RelPath) {
    return this.data.get(key)?.text ?? null;
  }
  protected async put(key: RelPath, text: string) {
    this.data.set(key, { text, version: ++this.counter });
  }
  protected async del(keys: RelPath[]) {
    for (const k of keys) this.data.delete(k);
  }
  /** Para tests: las claves tal cual están guardadas. */
  dump(): RelPath[] {
    return [...this.data.keys()].sort();
  }
}
