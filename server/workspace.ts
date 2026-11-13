// Los diagramas de una raíz y sus reglas: árbol, links, comentarios, renombrar con links al día, papelera.
// Lo usan el servidor HTTP, el MCP, el sitio y la nube. Dónde se guardan los archivos lo decide el Store
// (server/store.ts): el disco por defecto, o un depósito como Vercel Blob.
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  COMMENTS_SUFFIX, DIAGRAM_EXT, emptyDiagram, makeDiagramLink, parseDiagramLink, resolveLinkTarget,
  type CommentsFile, type ExcalidrawFile, type RelPath, type TreeEntry,
} from "../shared/types.ts";
import { DiskStore, IGNORED_DIRS, type Store } from "./store.ts";

export class WorkspaceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function hashOf(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

/** La carpeta más cercana hacia arriba que tiene `.git` (carpeta o archivo, como en un worktree). */
export function gitRoot(dir: string): string | null {
  for (let d = dir; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, ".git"))) return d;
    if (path.dirname(d) === d) return null;
  }
}

export class Workspace {
  /** En disco, la carpeta absoluta; si no, el nombre del store (p. ej. "vercel-blob:diagramas"). */
  root: string;
  readonly store: Store;
  private linkCache = new Map<string, { version: string; links: RelPath[] }>();

  constructor(rootOrStore: string | Store) {
    this.store = typeof rootOrStore === "string" ? new DiskStore(rootOrStore) : rootOrStore;
    this.root = this.store instanceof DiskStore ? this.store.root : this.store.label;
  }

  get rootName(): string {
    return path.basename(this.root);
  }

  /** Valida una ruta relativa: dentro de la raíz, sin "..", sin carpetas ignoradas. Devuelve la ruta tal cual. */
  check(rel: RelPath): RelPath {
    if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0") || rel.includes("\\") || rel.startsWith("/")) {
      throw new WorkspaceError(400, "Ruta inválida");
    }
    const parts = rel.split("/");
    if (parts.some((p) => p === "" || p === "." || p === "..")) throw new WorkspaceError(400, "La ruta sale del workspace");
    if (parts.some((p) => IGNORED_DIRS.has(p))) throw new WorkspaceError(400, "Ruta no permitida");
    return rel;
  }

  /** Solo en disco: la ruta absoluta (validada). */
  resolve(rel: RelPath): string {
    if (!(this.store instanceof DiskStore)) throw new Error("Este workspace no está en disco");
    return this.store.abs(this.check(rel));
  }

  private checkDiagram(rel: RelPath): RelPath {
    if (typeof rel !== "string" || !rel.endsWith(DIAGRAM_EXT)) throw new WorkspaceError(400, `La ruta debe terminar en ${DIAGRAM_EXT}`);
    return this.check(rel);
  }

  toRel(abs: string): RelPath {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  async tree(): Promise<TreeEntry[]> {
    const { files, dirs } = await this.store.list();
    // Una carpeta se lista si tiene diagramas adentro (a cualquier profundidad), si está vacía (recién creada)
    // o si adentro hay otra que se lista. Las que solo tienen otras cosas (código, imágenes) no.
    const withDiagrams = new Set<RelPath>();
    for (const f of files) for (let d = path.posix.dirname(f.path); d !== "."; d = path.posix.dirname(d)) withDiagrams.add(d);
    const kept = new Set<RelPath>();
    for (const d of [...dirs].sort((a, b) => b.path.split("/").length - a.path.split("/").length)) {
      if (withDiagrams.has(d.path) || d.empty || kept.has(d.path)) {
        kept.add(d.path);
        const parent = path.posix.dirname(d.path);
        if (parent !== ".") kept.add(parent);
      }
    }
    const entries: TreeEntry[] = dirs.filter((d) => kept.has(d.path)).map((d) => ({ path: d.path, type: "dir" }));
    for (const f of files) {
      entries.push({ path: f.path, type: "file", links: await this.linksOf(f.path, f.version), openComments: await this.openComments(f.path) });
    }
    // Mismo orden que recorrer el disco: por nombre en cada nivel, cada carpeta seguida de lo que tiene adentro.
    return entries.sort((a, b) => comparePaths(a.path, b.path));
  }

  private async linksOf(rel: RelPath, version: string): Promise<RelPath[]> {
    const cached = this.linkCache.get(rel);
    if (cached && version && cached.version === version) return cached.links;
    try {
      const data = JSON.parse((await this.store.read(rel)) ?? "");
      const links = new Set<RelPath>();
      for (const el of data.elements ?? []) {
        if (el.isDeleted) continue;
        const parsed = parseDiagramLink(el.link);
        if (parsed) links.add(parsed.path);
      }
      const result = [...links];
      this.linkCache.set(rel, { version, links: result });
      return result;
    } catch {
      return [];
    }
  }

  private async openComments(rel: RelPath): Promise<number> {
    try {
      const c = await this.readComments(rel);
      return c.comments.filter((x) => !x.resolved).length;
    } catch {
      return 0;
    }
  }

  async exists(rel: RelPath): Promise<boolean> {
    return (await this.store.kind(this.check(rel))) !== null;
  }

  async readDiagram(rel: RelPath): Promise<{ content: ExcalidrawFile; hash: string }> {
    const text = await this.store.read(this.checkDiagram(rel));
    if (text === null) throw new WorkspaceError(404, `No existe ${rel}`);
    if (text.trim() === "") return { content: emptyDiagram(), hash: hashOf(text) };
    try {
      const content = JSON.parse(text);
      content.elements ??= [];
      content.appState ??= {};
      content.files ??= {};
      return { content, hash: hashOf(text) };
    } catch {
      throw new WorkspaceError(422, `${rel} no es JSON válido`);
    }
  }

  /**
   * Escribe un diagrama entero. Si se pasa `baseHash` y el archivo cambió desde entonces, falla con 409 para no
   * pisar cambios ajenos.
   */
  async writeDiagram(rel: RelPath, content: ExcalidrawFile, opts: { baseHash?: string; mustNotExist?: boolean } = {}): Promise<string> {
    this.checkDiagram(rel);
    if (opts.mustNotExist && (await this.exists(rel))) throw new WorkspaceError(409, `Ya existe ${rel}`);
    if (opts.baseHash) {
      const current = await this.store.read(rel);
      if (current !== null && hashOf(current) !== opts.baseHash) {
        throw new WorkspaceError(409, "El archivo cambió en disco");
      }
    }
    const text = JSON.stringify(
      { type: "excalidraw", version: 2, source: content.source ?? "serrugrams", elements: content.elements ?? [], appState: content.appState ?? {}, files: content.files ?? {} },
      null,
      2,
    ) + "\n";
    await this.store.write(rel, text);
    return hashOf(text);
  }

  private commentsKey(rel: RelPath): RelPath {
    return this.checkDiagram(rel) + COMMENTS_SUFFIX;
  }

  async readComments(rel: RelPath): Promise<CommentsFile> {
    try {
      const data = JSON.parse((await this.store.read(this.commentsKey(rel))) ?? "");
      return { version: 1, comments: Array.isArray(data.comments) ? data.comments : [] };
    } catch {
      return { version: 1, comments: [] };
    }
  }

  async writeComments(rel: RelPath, data: CommentsFile): Promise<void> {
    const key = this.commentsKey(rel);
    if (data.comments.length === 0) {
      await this.store.remove(key);
      return;
    }
    await this.store.write(key, JSON.stringify({ version: 1, comments: data.comments }, null, 2) + "\n");
  }

  async mkdir(rel: RelPath): Promise<void> {
    await this.store.mkdir(this.check(rel));
  }

  /** Renombra o mueve un diagrama o carpeta. Mueve también el sidecar de comentarios. */
  async rename(from: RelPath, to: RelPath): Promise<void> {
    this.check(from);
    this.check(to);
    if (await this.exists(to)) throw new WorkspaceError(409, `Ya existe ${to}`);
    const kind = await this.store.kind(from);
    if (!kind) throw new WorkspaceError(404, `No existe ${from}`);
    if (kind === "file" && (!from.endsWith(DIAGRAM_EXT) || !to.endsWith(DIAGRAM_EXT))) {
      throw new WorkspaceError(400, `Solo se pueden renombrar archivos ${DIAGRAM_EXT}`);
    }
    await this.store.move(from, to);
    if (kind === "file" && (await this.store.kind(from + COMMENTS_SUFFIX)) === "file") {
      await this.store.move(from + COMMENTS_SUFFIX, to + COMMENTS_SUFFIX);
    }
    await this.rewriteLinks(from, to, kind === "dir");
  }

  /**
   * Tras un rename, actualiza los links de los demás diagramas que apuntaban a la ruta vieja. Los links son
   * relativos a la raíz de los diagramas del repo, que puede estar más adentro que esta raíz (un diagrama suelto
   * de la vista tiene como raíz el repo entero): se resuelven igual que en la UI y se reescriben con la misma base.
   */
  private async rewriteLinks(from: RelPath, to: RelPath, isDir: boolean): Promise<void> {
    const map = (p: RelPath): RelPath | null => {
      if (!isDir) return p === from ? to : null;
      return p.startsWith(from + "/") ? to + p.slice(from.length) : null;
    };
    const entries = await this.tree();
    const files = new Set(entries.filter((e) => e.type === "file").map((e) => e.path));
    // Se resuelve contra cómo estaba antes del rename: la ruta vieja "existe".
    const existed = (p: RelPath) => files.has(p) || p === from || (isDir && p.startsWith(from + "/"));
    const resolve = (owner: RelPath, raw: RelPath) => resolveLinkTarget("_/" + owner, raw, (p) => existed(p.slice(2))).slice(2);
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      if (!entry.links?.some((l) => map(resolve(entry.path, l)) !== null)) continue;
      const { content, hash } = await this.readDiagram(entry.path);
      let changed = false;
      for (const el of content.elements) {
        const parsed = parseDiagramLink(el.link);
        if (!parsed) continue;
        const resolved = resolve(entry.path, parsed.path);
        const next = map(resolved);
        if (!next) continue;
        const base = resolved.slice(0, resolved.length - parsed.path.length).replace(/\/$/, "");
        el.link = makeDiagramLink(base && next.startsWith(base + "/") ? next.slice(base.length + 1) : next, parsed.elementId);
        el.version = (el.version ?? 1) + 1;
        el.versionNonce = Math.floor(Math.random() * 2 ** 31);
        el.updated = Date.now();
        changed = true;
      }
      if (changed) {
        try {
          await this.writeDiagram(entry.path, content, { baseHash: hash });
        } catch {}
      }
    }
  }

  /** No borra: mueve a `.serrugrams/trash/<fecha>/` dentro del workspace. */
  async trash(rel: RelPath): Promise<void> {
    this.check(rel);
    const kind = await this.store.kind(rel);
    if (!kind) throw new WorkspaceError(404, `No existe ${rel}`);
    if (kind === "file" && !rel.endsWith(DIAGRAM_EXT)) throw new WorkspaceError(400, "Solo se pueden eliminar diagramas o carpetas");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dst = `.serrugrams/trash/${stamp}/${rel}`;
    await this.store.move(rel, dst);
    if (kind === "file" && (await this.store.kind(rel + COMMENTS_SUFFIX)) === "file") {
      await this.store.move(rel + COMMENTS_SUFFIX, dst + COMMENTS_SUFFIX);
    }
  }
}

/** Orden de recorrido: por nombre en cada nivel, y una carpeta antes que lo que tiene adentro. */
function comparePaths(a: RelPath, b: RelPath): number {
  const pa = a.split("/");
  const pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) return pa[i].localeCompare(pb[i]);
  }
  return pa.length - pb.length;
}

export function newId(): string {
  return randomBytes(10).toString("base64url");
}
