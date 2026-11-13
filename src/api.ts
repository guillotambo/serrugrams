import type { CommentsFile, Dropped, ExcalidrawFile, FileResponse, RefInfo, RelPath, ServerEvent, TreeResponse } from "../shared/types.ts";
import { CLOUD, LIVE_EVENTS, SITE } from "./mode.ts";
import { siteData } from "./site.ts";

/** En la nube, un 401 quiere decir que la sesión venció: la UI pide la contraseña encima de lo abierto (src/Login.tsx). */
export const AUTH_EVENT = "serrugrams:auth";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  // En el sitio estático no hay servidor: lo que no se lee de data/ falla acá, a la vista, en vez de pedirle a /api.
  if (SITE) throw new ApiError(405, "Este sitio es de solo lectura");
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = (await res.json()).error ?? message;
    } catch {}
    if (res.status === 401 && CLOUD && url !== "/api/login") window.dispatchEvent(new Event(AUTH_EVENT));
    throw new ApiError(res.status, message);
  }
  return res.json();
}

const qp = (path: RelPath) => "?path=" + encodeURIComponent(path);

export const api = {
  tree: () => (SITE ? siteData.tree() : call<TreeResponse>("GET", "/api/tree")),
  addRef: (path: string) => call<{ ref: RefInfo }>("POST", "/api/refs", { path }),
  renameRef: (id: string, next: string) => call<{ id: string }>("PATCH", "/api/refs", { id, next }),
  removeRef: (id: string) => call<{ ok: true }>("DELETE", "/api/refs?id=" + encodeURIComponent(id), {}),
  canPick: () => call<{ available: boolean }>("GET", "/api/pick"),
  pick: (start: string) => call<{ path: string | null }>("POST", "/api/pick", { start }),
  locate: (dropped: Dropped) => call<{ paths: string[]; home: string }>("POST", "/api/locate", dropped),
  complete: (prefix: string) => call<{ items: string[] }>("GET", "/api/complete?prefix=" + encodeURIComponent(prefix)),
  readFile: (path: RelPath) =>
    SITE
      ? siteData.readFile(path).then((r) => r ?? Promise.reject(new ApiError(404, `No existe ${path}`)))
      : call<FileResponse>("GET", "/api/file" + qp(path)),
  saveFile: (path: RelPath, content: ExcalidrawFile, baseHash?: string) =>
    call<{ hash: string }>("PUT", "/api/file" + qp(path), { content, baseHash }),
  createFile: (path: RelPath, content?: ExcalidrawFile, comments?: CommentsFile) =>
    call<{ hash: string }>("POST", "/api/file", { path, content, comments }),
  remove: (path: RelPath) => call<{ ok: true }>("DELETE", "/api/entry" + qp(path), {}),
  rename: (from: RelPath, to: RelPath) => call<{ ok: true }>("POST", "/api/rename", { from, to }),
  mkdir: (path: RelPath) => call<{ ok: true }>("POST", "/api/dir", { path }),
  readComments: (path: RelPath) => (SITE ? siteData.readComments(path) : call<CommentsFile>("GET", "/api/comments" + qp(path))),
  saveComments: (path: RelPath, data: CommentsFile) => call<{ ok: true }>("PUT", "/api/comments" + qp(path), data),
  session: () => call<{ ok: true }>("GET", "/api/session"),
  login: (password: string) => call<{ ok: true }>("POST", "/api/login", { password }),
  logout: () => call<{ ok: true }>("POST", "/api/logout", {}),
};

/** Suscripción a eventos del servidor; reconecta sola. Devuelve la función para cortar. */
export function subscribe(onEvent: (e: ServerEvent | { type: "hello" }) => void): () => void {
  if (!LIVE_EVENTS) return () => {}; // sitio estático o nube: no hay eventos en vivo
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {}
  };
  return () => es.close();
}
