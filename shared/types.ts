// Contratos compartidos entre servidor, UI y MCP.

/** Extensión de los diagramas. El contenido es JSON estándar de Excalidraw. */
export const DIAGRAM_EXT = ".excalidraw";
/** Sufijo del archivo sidecar de comentarios: `foo.excalidraw.comments.json`. */
export const COMMENTS_SUFFIX = ".comments.json";

/** Ruta POSIX relativa a la raíz del workspace, sin "/" inicial. Ej: "pagos/detalle.excalidraw". */
export type RelPath = string;

export interface TreeEntry {
  path: RelPath;
  type: "file" | "dir";
  /** Solo archivos: rutas de diagramas a los que linkea (resueltas, relativas a la raíz). */
  links?: RelPath[];
  /** Solo archivos: cantidad de comentarios sin resolver. */
  openComments?: number;
  /** Existe y se puede abrir (p. ej. por un link), pero no está en la vista. */
  hidden?: boolean;
}

/**
 * Una referencia de la vista: una carpeta o un diagrama suelto de algún repo.
 * Las rutas globales que usan la UI y la API son `<id>/<ruta dentro de root>`.
 */
export interface RefInfo {
  id: string;
  /** Ruta absoluta a la carpeta o al diagrama, tal como se agregó. */
  path: string;
  kind: "folder" | "file";
  /** Carpeta raíz absoluta: la carpeta misma, o la raíz del repo de un diagrama suelto. */
  root: string;
  /** Diagrama suelto: su ruta global. */
  file?: RelPath;
  /** La ruta ya no existe. */
  missing?: boolean;
}

export interface TreeResponse {
  refs: RefInfo[];
  entries: TreeEntry[];
}

/** Primer tramo de una ruta global: el id de la referencia. */
export const refIdOf = (p: RelPath) => p.split("/")[0];

/**
 * Resuelve el destino de un link guardado en el diagrama `from` (ruta global). El link es relativo a la raíz
 * de los diagramas del repo, que puede no ser la raíz de la referencia: se prueba desde la raíz de la
 * referencia hacia la carpeta de `from` y gana el primero que existe. Si ninguno existe, se devuelve el de la raíz.
 */
export function resolveLinkTarget(from: RelPath, target: RelPath, exists: (p: RelPath) => boolean): RelPath {
  const [id, ...rest] = from.split("/");
  const dirs = rest.slice(0, -1);
  for (let i = 0; i <= dirs.length; i++) {
    const candidate = [id, ...dirs.slice(0, i), target].join("/");
    if (exists(candidate)) return candidate;
  }
  return `${id}/${target}`;
}

/**
 * Lo inverso: la ruta a guardar en un link desde `from` hacia `target` (globales), relativa a `base`
 * (ruta global de una carpeta: la raíz de la referencia o la carpeta de un diagrama suelto).
 * Devuelve null si son de referencias distintas.
 */
export function linkPathFor(target: RelPath, base: RelPath): RelPath | null {
  const id = refIdOf(base);
  if (refIdOf(target) !== id) return null;
  if (target.startsWith(base + "/")) return target.slice(base.length + 1);
  return target.slice(id.length + 1);
}

export interface ExcalidrawFile {
  type: "excalidraw";
  version: 2;
  source: string;
  elements: any[];
  appState: Record<string, any>;
  files: Record<string, any>;
}

export interface FileResponse {
  path: RelPath;
  content: ExcalidrawFile;
  /** Hash del contenido en disco; se usa para detectar ecos y conflictos. */
  hash: string;
}

export interface CommentReply {
  id: string;
  author: string;
  createdAt: string;
  text: string;
}

export interface Comment {
  id: string;
  /**
   * Ancla. Si `elementId` existe en la escena, la posición es
   * (element.x + offset.x, element.y + offset.y). Si no, se usa (x, y) en
   * coordenadas de escena, que siempre se guarda como respaldo.
   */
  anchor: { elementId?: string; offset?: { x: number; y: number }; x: number; y: number };
  author: string;
  createdAt: string;
  resolved: boolean;
  text: string;
  replies: CommentReply[];
}

export interface CommentsFile {
  version: 1;
  comments: Comment[];
}

/** Eventos SSE de GET /api/events. */
export type ServerEvent =
  | { type: "tree" }
  | { type: "file"; path: RelPath; hash: string }
  | { type: "comments"; path: RelPath };

/**
 * Links entre diagramas: se guardan en `element.link` (campo nativo de
 * Excalidraw) como ruta absoluta dentro del workspace, con "/" inicial y
 * opcionalmente `#<elementId>` para enfocar un elemento:
 *   "/pagos/detalle.excalidraw#abc123"
 */
export const DIAGRAM_LINK_RE = /^\/(?!\/)([^#?]+\.excalidraw)(?:#(.+))?$/;

export function parseDiagramLink(link: string | null | undefined): { path: RelPath; elementId?: string } | null {
  if (!link) return null;
  const m = DIAGRAM_LINK_RE.exec(link);
  if (!m) return null;
  let path: string;
  try { path = decodeURI(m[1]); } catch { path = m[1]; }
  return { path, elementId: m[2] };
}

export function makeDiagramLink(path: RelPath, elementId?: string): string {
  return "/" + encodeURI(path) + (elementId ? "#" + elementId : "");
}

export function emptyDiagram(): ExcalidrawFile {
  return { type: "excalidraw", version: 2, source: "serrugrams", elements: [], appState: { viewBackgroundColor: "#ffffff" }, files: {} };
}
