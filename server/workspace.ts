// Acceso a disco confinado a la raíz del workspace. Lo usan el servidor HTTP y el MCP.
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  COMMENTS_SUFFIX, DIAGRAM_EXT, emptyDiagram, makeDiagramLink, parseDiagramLink, resolveLinkTarget,
  type CommentsFile, type ExcalidrawFile, type RelPath, type TreeEntry,
} from "../shared/types.ts";

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".serrugrams", ".next", "target", "vendor"]);

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

export class Workspace {
  root: string;
  private linkCache = new Map<string, { mtimeMs: number; links: RelPath[] }>();

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  get rootName(): string {
    return path.basename(this.root);
  }

  /** Resuelve una ruta relativa y garantiza que quede dentro de la raíz. */
  resolve(rel: RelPath): string {
    if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) {
      throw new WorkspaceError(400, "Ruta inválida");
    }
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new WorkspaceError(400, "La ruta sale del workspace");
    }
    const parts = path.relative(this.root, abs).split(path.sep);
    if (parts.some((p) => IGNORED_DIRS.has(p))) throw new WorkspaceError(400, "Ruta no permitida");
    return abs;
  }

  private resolveDiagram(rel: RelPath): string {
    if (!rel.endsWith(DIAGRAM_EXT)) throw new WorkspaceError(400, `La ruta debe terminar en ${DIAGRAM_EXT}`);
    return this.resolve(rel);
  }

  toRel(abs: string): RelPath {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  async tree(): Promise<TreeEntry[]> {
    const entries: TreeEntry[] = [];
    const walk = async (dir: string): Promise<boolean> => {
      let hasDiagram = false;
      let items: import("node:fs").Dirent[];
      try {
        items = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return false;
      }
      items.sort((a, b) => a.name.localeCompare(b.name));
      for (const item of items) {
        const abs = path.join(dir, item.name);
        if (item.isDirectory()) {
          if (IGNORED_DIRS.has(item.name) || item.name.startsWith(".")) continue;
          const idx = entries.length;
          entries.push({ path: this.toRel(abs), type: "dir" });
          const sub = await walk(abs);
          // Las carpetas sin diagramas no se listan, salvo que estén vacías (recién creadas).
          if (!sub && (await isNonEmptyDir(abs))) entries.splice(idx, entries.length - idx);
          else hasDiagram = true;
        } else if (item.isFile() && item.name.endsWith(DIAGRAM_EXT)) {
          hasDiagram = true;
          const rel = this.toRel(abs);
          entries.push({ path: rel, type: "file", links: await this.linksOf(rel), openComments: await this.openComments(rel) });
        }
      }
      return hasDiagram;
    };
    await walk(this.root);
    return entries;
  }

  private async linksOf(rel: RelPath): Promise<RelPath[]> {
    const abs = this.resolve(rel);
    try {
      const stat = await fs.stat(abs);
      const cached = this.linkCache.get(rel);
      if (cached && cached.mtimeMs === stat.mtimeMs) return cached.links;
      const data = JSON.parse(await fs.readFile(abs, "utf8"));
      const links = new Set<RelPath>();
      for (const el of data.elements ?? []) {
        if (el.isDeleted) continue;
        const parsed = parseDiagramLink(el.link);
        if (parsed) links.add(parsed.path);
      }
      const result = [...links];
      this.linkCache.set(rel, { mtimeMs: stat.mtimeMs, links: result });
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
    try {
      await fs.access(this.resolve(rel));
      return true;
    } catch {
      return false;
    }
  }

  async readDiagram(rel: RelPath): Promise<{ content: ExcalidrawFile; hash: string }> {
    const abs = this.resolveDiagram(rel);
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch {
      throw new WorkspaceError(404, `No existe ${rel}`);
    }
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
   * Escribe un diagrama de forma atómica. Si se pasa `baseHash` y el archivo
   * cambió en disco desde entonces, falla con 409 para no pisar cambios ajenos.
   */
  async writeDiagram(rel: RelPath, content: ExcalidrawFile, opts: { baseHash?: string; mustNotExist?: boolean } = {}): Promise<string> {
    const abs = this.resolveDiagram(rel);
    if (opts.mustNotExist && (await this.exists(rel))) throw new WorkspaceError(409, `Ya existe ${rel}`);
    if (opts.baseHash) {
      let current: string | null = null;
      try {
        current = hashOf(await fs.readFile(abs, "utf8"));
      } catch {}
      if (current !== null && current !== opts.baseHash) {
        throw new WorkspaceError(409, "El archivo cambió en disco");
      }
    }
    const text = JSON.stringify(
      { type: "excalidraw", version: 2, source: content.source ?? "serrugrams", elements: content.elements ?? [], appState: content.appState ?? {}, files: content.files ?? {} },
      null,
      2,
    ) + "\n";
    await atomicWrite(abs, text);
    return hashOf(text);
  }

  commentsPath(rel: RelPath): string {
    return this.resolveDiagram(rel) + COMMENTS_SUFFIX;
  }

  async readComments(rel: RelPath): Promise<CommentsFile> {
    try {
      const data = JSON.parse(await fs.readFile(this.commentsPath(rel), "utf8"));
      return { version: 1, comments: Array.isArray(data.comments) ? data.comments : [] };
    } catch {
      return { version: 1, comments: [] };
    }
  }

  async writeComments(rel: RelPath, data: CommentsFile): Promise<void> {
    const file = this.commentsPath(rel);
    if (data.comments.length === 0) {
      await fs.rm(file, { force: true });
      return;
    }
    await atomicWrite(file, JSON.stringify({ version: 1, comments: data.comments }, null, 2) + "\n");
  }

  async mkdir(rel: RelPath): Promise<void> {
    await fs.mkdir(this.resolve(rel), { recursive: true });
  }

  /** Renombra o mueve un diagrama o carpeta. Mueve también el sidecar de comentarios. */
  async rename(from: RelPath, to: RelPath): Promise<void> {
    const src = this.resolve(from);
    const dst = this.resolve(to);
    if (await this.exists(to)) throw new WorkspaceError(409, `Ya existe ${to}`);
    let stat;
    try {
      stat = await fs.stat(src);
    } catch {
      throw new WorkspaceError(404, `No existe ${from}`);
    }
    if (stat.isFile() && (!from.endsWith(DIAGRAM_EXT) || !to.endsWith(DIAGRAM_EXT))) {
      throw new WorkspaceError(400, `Solo se pueden renombrar archivos ${DIAGRAM_EXT}`);
    }
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    if (stat.isFile()) {
      try {
        await fs.rename(src + COMMENTS_SUFFIX, dst + COMMENTS_SUFFIX);
      } catch {}
    }
    await this.rewriteLinks(from, to, stat.isDirectory());
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

  /** No borra: mueve a `.serrugrams/trash/` dentro del workspace. */
  async trash(rel: RelPath): Promise<void> {
    const src = this.resolve(rel);
    let stat;
    try {
      stat = await fs.stat(src);
    } catch {
      throw new WorkspaceError(404, `No existe ${rel}`);
    }
    if (stat.isFile() && !rel.endsWith(DIAGRAM_EXT)) throw new WorkspaceError(400, "Solo se pueden eliminar diagramas o carpetas");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dstDir = path.join(this.root, ".serrugrams", "trash", stamp);
    await fs.mkdir(path.join(dstDir, path.dirname(rel)), { recursive: true });
    await fs.rename(src, path.join(dstDir, rel));
    if (stat.isFile()) {
      try {
        await fs.rename(src + COMMENTS_SUFFIX, path.join(dstDir, rel + COMMENTS_SUFFIX));
      } catch {}
    }
  }
}

async function isNonEmptyDir(abs: string): Promise<boolean> {
  try {
    return (await fs.readdir(abs)).length > 0;
  } catch {
    return true;
  }
}

async function atomicWrite(abs: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${randomBytes(4).toString("hex")}.tmp`);
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, abs);
}

export function newId(): string {
  return randomBytes(10).toString("base64url");
}
