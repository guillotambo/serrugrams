// La vista: referencias a carpetas o diagramas sueltos de cualquier repo, anotadas en un archivo JSON.
// Cada referencia tiene una raíz (la carpeta, o la raíz del repo de un diagrama suelto) y su propio Workspace.
// Las rutas globales son `<id>/<ruta dentro de la raíz>`. Ver docs/referencias.md.
import chokidar, { type FSWatcher } from "chokidar";
import { existsSync, promises as fs, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { COMMENTS_SUFFIX, DIAGRAM_EXT, resolveLinkTarget, type RefInfo, type RelPath, type ServerEvent, type TreeEntry, type TreeResponse } from "../shared/types.ts";
import { Workspace, WorkspaceError, hashOf } from "./workspace.ts";

interface RefConfig {
  id: string;
  path: string;
}

interface Ref extends RefInfo {
  ws?: Workspace;
  watcher?: FSWatcher;
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function gitRoot(dir: string): string | null {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return null;
  }
}

const GENERIC = new Set(["docs", "doc", "diagramas", "diagrams", "diagrama"]);
const ID_FORBIDDEN = /[\\/:*?"<>|#%\0]/g;

/** Nombre sugerido: `…/pagos/docs/diagramas` → `pagos`; un diagrama suelto toma el nombre de su repo. */
function suggestId(abs: string, kind: "folder" | "file"): string {
  let p = kind === "file" ? gitRoot(path.dirname(abs)) ?? path.dirname(abs) : abs;
  while (GENERIC.has(path.basename(p).toLowerCase()) && path.dirname(p) !== p) p = path.dirname(p);
  return cleanId(path.basename(p)) || "diagramas";
}

function cleanId(name: string): string {
  return name.replace(ID_FORBIDDEN, "-").replace(/^\.+/, "").trim();
}

const isWatched = (root: string) => (p: string, stats?: import("node:fs").Stats) => {
  const base = path.basename(p);
  if (p !== root && (base === "node_modules" || base === "dist" || base.startsWith("."))) return true;
  if (stats?.isFile()) return !(p.endsWith(DIAGRAM_EXT) || p.endsWith(DIAGRAM_EXT + COMMENTS_SUFFIX));
  return false;
};

export class Refs {
  readonly file: string;
  private refs: Ref[] = [];
  private emit: (e: ServerEvent) => void;
  private fileWatcher: FSWatcher | null = null;
  /** Últimos contenidos que escribió este proceso: sus propios avisos no son cambios externos, aunque lleguen tarde. */
  private written: string[] = [];
  private treeTimer: NodeJS.Timeout | null = null;
  private missingTimer: NodeJS.Timeout | null = null;

  constructor(file: string, emit: (e: ServerEvent) => void) {
    this.file = path.resolve(file);
    this.emit = emit;
  }

  /** Lee el archivo de referencias y empieza a vigilarlo (si otro proceso lo cambia, la vista se recarga). */
  async start(): Promise<void> {
    await this.load();
    this.fileWatcher = chokidar.watch(this.file, { ignoreInitial: true });
    const onChange = async () => {
      let text = "";
      try {
        text = await fs.readFile(this.file, "utf8");
      } catch {}
      if (this.written.includes(text)) return;
      await this.load();
      this.treeChanged();
    };
    this.fileWatcher.on("add", onChange).on("change", onChange).on("unlink", onChange);
    // Una referencia perdida puede volver (se montó un disco, se clonó el repo de nuevo) sin que nada avise.
    this.missingTimer = setInterval(async () => {
      if (await this.checkMissing()) this.treeChanged();
    }, 4000);
    this.missingTimer.unref();
  }

  async close(): Promise<void> {
    if (this.missingTimer) clearInterval(this.missingTimer);
    await this.fileWatcher?.close();
    await Promise.all(this.refs.map((r) => r.watcher?.close()));
  }

  private async load(): Promise<void> {
    let configs: RefConfig[] = [];
    try {
      const data = JSON.parse(await fs.readFile(this.file, "utf8"));
      if (Array.isArray(data.refs)) configs = data.refs.filter((r: any) => typeof r?.id === "string" && typeof r?.path === "string");
    } catch {}
    await Promise.all(this.refs.map((r) => r.watcher?.close()));
    const seen = new Set<string>();
    this.refs = [];
    for (const c of configs) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      this.refs.push(await this.open(c));
    }
  }

  private async save(): Promise<void> {
    const text = JSON.stringify({ version: 1, refs: this.refs.map((r) => ({ id: r.id, path: r.path })) }, null, 2) + "\n";
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(tmp, text, "utf8");
    this.written = [...this.written.slice(-19), text];
    await fs.rename(tmp, this.file);
  }

  /** Arma una referencia: tipo, raíz, Workspace y vigilante. Si la ruta no existe, queda como `missing`. */
  private async open(c: RefConfig): Promise<Ref> {
    let stat: import("node:fs").Stats | null = null;
    try {
      stat = await fs.stat(c.path);
    } catch {}
    if (stat?.isDirectory()) return this.watch({ id: c.id, path: c.path, kind: "folder", root: c.path });
    if (stat?.isFile() && c.path.endsWith(DIAGRAM_EXT)) {
      const dir = path.dirname(c.path);
      const root = gitRoot(dir) ?? dir;
      return this.watch({ id: c.id, path: c.path, kind: "file", root, file: `${c.id}/${path.relative(root, c.path).split(path.sep).join("/")}` });
    }
    return { id: c.id, path: c.path, kind: c.path.endsWith(DIAGRAM_EXT) ? "file" : "folder", root: c.path, missing: true };
  }

  private watch(ref: Ref): Ref {
    const ws = new Workspace(ref.root);
    ref.ws = ws;
    ref.watcher = chokidar.watch(ref.root, { ignoreInitial: true, ignored: isWatched(ref.root) });
    const onFile = async (abs: string, kind: "add" | "change" | "unlink") => {
      const global = `${ref.id}/${ws.toRel(abs)}`;
      if (global.endsWith(COMMENTS_SUFFIX)) {
        this.emit({ type: "comments", path: global.slice(0, -COMMENTS_SUFFIX.length) });
      } else if (kind !== "unlink") {
        try {
          this.emit({ type: "file", path: global, hash: hashOf(await fs.readFile(abs, "utf8")) });
        } catch {}
      }
      // Si se borra o vuelve a aparecer el diagrama de una referencia suelta, cambia su estado.
      if (ref.kind === "file" && abs === ref.path && kind !== "change") void this.reopen(ref.id);
      this.treeChanged();
    };
    ref.watcher
      .on("add", (p) => onFile(p, "add"))
      .on("change", (p) => onFile(p, "change"))
      .on("unlink", (p) => onFile(p, "unlink"))
      .on("addDir", () => this.treeChanged())
      .on("unlinkDir", () => this.treeChanged());
    return ref;
  }

  private async reopen(id: string): Promise<void> {
    const ref = this.refs.find((r) => r.id === id);
    if (!ref) return;
    await ref.watcher?.close();
    const next = await this.open({ id, path: ref.path });
    // Si mientras tanto otro cambio (moved, rename) la reemplazó, gana ese: no se pisa con la ruta vieja.
    const i = this.refs.indexOf(ref);
    if (i < 0) {
      await next.watcher?.close();
      return;
    }
    this.refs[i] = next;
    this.treeChanged();
  }

  treeChanged(): void {
    if (this.treeTimer) clearTimeout(this.treeTimer);
    this.treeTimer = setTimeout(() => this.emit({ type: "tree" }), 80);
  }

  info(): RefInfo[] {
    return this.refs.map(({ ws, watcher, ...info }) => info);
  }

  /** Agrega una carpeta o un diagrama a la vista. Si ya está, devuelve la referencia existente. */
  async add(input: string, id?: string): Promise<RefInfo> {
    if (typeof input !== "string" || !input.trim()) throw new WorkspaceError(400, "Falta la ruta");
    let abs = path.resolve(expandHome(input.trim()));
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(abs);
    } catch {
      throw new WorkspaceError(404, `No existe ${input}`);
    }
    if (!stat.isDirectory() && !(stat.isFile() && abs.endsWith(DIAGRAM_EXT))) {
      throw new WorkspaceError(400, `Tiene que ser una carpeta o un archivo ${DIAGRAM_EXT}`);
    }
    abs = realpathSync(abs);
    const existing = this.refs.find((r) => r.path === abs);
    if (existing) return this.info().find((r) => r.id === existing.id)!;
    const kind = stat.isDirectory() ? "folder" : "file";
    const ref = await this.open({ id: this.uniqueId(id ? cleanId(id) : suggestId(abs, kind)), path: abs });
    this.refs.push(ref);
    await this.save();
    this.treeChanged();
    return this.info().find((r) => r.id === ref.id)!;
  }

  async remove(id: string): Promise<void> {
    const ref = this.refs.find((r) => r.id === id);
    if (!ref) throw new WorkspaceError(404, `No hay ninguna referencia "${id}"`);
    await ref.watcher?.close();
    this.refs = this.refs.filter((r) => r !== ref);
    await this.save();
    this.treeChanged();
  }

  async rename(id: string, next: string): Promise<string> {
    const ref = this.refs.find((r) => r.id === id);
    if (!ref) throw new WorkspaceError(404, `No hay ninguna referencia "${id}"`);
    const clean = cleanId(next ?? "");
    if (!clean) throw new WorkspaceError(400, "Nombre inválido");
    if (clean === id) return id;
    if (this.refs.some((r) => r.id === clean)) throw new WorkspaceError(409, `Ya hay una referencia "${clean}"`);
    const i = this.refs.indexOf(ref);
    await ref.watcher?.close();
    this.refs[i] = await this.open({ id: clean, path: ref.path });
    await this.save();
    this.treeChanged();
    return clean;
  }

  /** Tras renombrar o mover algo en disco, las referencias que apuntaban ahí (o adentro) pasan a la ruta nueva. */
  async moved(fromAbs: string, toAbs: string): Promise<void> {
    let changed = false;
    for (let i = 0; i < this.refs.length; i++) {
      const r = this.refs[i];
      const next = r.path === fromAbs ? toAbs : r.path.startsWith(fromAbs + path.sep) ? toAbs + r.path.slice(fromAbs.length) : null;
      if (!next) continue;
      await r.watcher?.close();
      this.refs[i] = await this.open({ id: r.id, path: next });
      changed = true;
    }
    if (changed) {
      await this.save();
      this.treeChanged();
    }
  }

  private uniqueId(base: string): string {
    if (!this.refs.some((r) => r.id === base)) return base;
    for (let n = 2; ; n++) if (!this.refs.some((r) => r.id === `${base}-${n}`)) return `${base}-${n}`;
  }

  /** De una ruta global a su referencia, su Workspace y la ruta dentro de la raíz. */
  locate(global: RelPath): { ref: RefInfo; ws: Workspace; rel: RelPath } {
    if (typeof global !== "string" || !global) throw new WorkspaceError(400, "Ruta inválida");
    const slash = global.indexOf("/");
    const id = slash < 0 ? global : global.slice(0, slash);
    const rel = slash < 0 ? "" : global.slice(slash + 1);
    const ref = this.refs.find((r) => r.id === id);
    if (!ref) throw new WorkspaceError(404, `"${id}" no está en la vista`);
    if (!ref.ws || ref.missing) throw new WorkspaceError(404, `No se encuentra ${ref.path}`);
    if (!rel) throw new WorkspaceError(400, "La ruta tiene que estar dentro de una referencia");
    return { ref, ws: ref.ws, rel };
  }

  /** Marca como perdidas las referencias cuya ruta ya no existe, y recupera las que volvieron. */
  private async checkMissing(): Promise<boolean> {
    let changed = false;
    for (const r of [...this.refs]) {
      // Desactualizada: figura perdida pero existe, o al revés.
      if (!!r.missing === existsSync(r.path)) {
        await this.reopen(r.id);
        changed = true;
      }
    }
    return changed;
  }

  async tree(): Promise<TreeResponse> {
    await this.checkMissing();

    const entries: TreeEntry[] = [];
    for (const ref of this.refs) {
      if (!ref.ws || ref.missing) continue;
      const own = (await ref.ws.tree()).map((e) => ({ ...e, path: `${ref.id}/${e.path}` }));
      const files = new Set(own.filter((e) => e.type === "file").map((e) => e.path));
      const resolved = own.map((e) => (e.links ? { ...e, links: [...new Set(e.links.map((l) => resolveLinkTarget(e.path, l, (p) => files.has(p))))] } : e));
      if (ref.kind === "folder") {
        entries.push({ path: ref.id, type: "dir" }, ...resolved);
      } else {
        // Diagrama suelto: lo demás del repo se puede abrir por link, pero no se muestra.
        for (const e of resolved) if (e.type === "file") entries.push(e.path === ref.file ? e : { ...e, hidden: true });
      }
    }
    return { refs: this.info(), entries };
  }
}

/** Sugerencias para el campo «Agregar a la vista»: carpetas y diagramas que empiezan con lo escrito. */
export async function completePath(prefix: string): Promise<string[]> {
  const typed = prefix || "~/";
  const abs = expandHome(typed);
  const dir = typed.endsWith("/") ? abs : path.dirname(abs);
  const start = typed.endsWith("/") ? "" : path.basename(abs);
  let items: import("node:fs").Dirent[];
  try {
    items = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const shown = typed.endsWith("/") ? typed : typed.slice(0, typed.length - start.length);
  return items
    .filter((d) => d.name.startsWith(start) && (start.startsWith(".") || !d.name.startsWith(".")))
    .filter((d) => d.isDirectory() || d.name.endsWith(DIAGRAM_EXT))
    .filter((d) => d.name !== "node_modules")
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, 30)
    .map((d) => shown + d.name + (d.isDirectory() ? "/" : ""));
}
