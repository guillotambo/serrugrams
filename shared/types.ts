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
}

export interface TreeResponse {
  rootName: string;
  entries: TreeEntry[];
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
