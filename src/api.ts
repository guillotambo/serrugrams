import type { CommentsFile, ExcalidrawFile, FileResponse, RefInfo, RelPath, ServerEvent, TreeResponse } from "../shared/types.ts";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
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
    throw new ApiError(res.status, message);
  }
  return res.json();
}

const qp = (path: RelPath) => "?path=" + encodeURIComponent(path);

export const api = {
  tree: () => call<TreeResponse>("GET", "/api/tree"),
  addRef: (path: string) => call<{ ref: RefInfo }>("POST", "/api/refs", { path }),
  renameRef: (id: string, next: string) => call<{ id: string }>("PATCH", "/api/refs", { id, next }),
  removeRef: (id: string) => call<{ ok: true }>("DELETE", "/api/refs?id=" + encodeURIComponent(id), {}),
  complete: (prefix: string) => call<{ items: string[] }>("GET", "/api/complete?prefix=" + encodeURIComponent(prefix)),
  readFile: (path: RelPath) => call<FileResponse>("GET", "/api/file" + qp(path)),
  saveFile: (path: RelPath, content: ExcalidrawFile, baseHash?: string) =>
    call<{ hash: string }>("PUT", "/api/file" + qp(path), { content, baseHash }),
  createFile: (path: RelPath, content?: ExcalidrawFile, comments?: CommentsFile) =>
    call<{ hash: string }>("POST", "/api/file", { path, content, comments }),
  remove: (path: RelPath) => call<{ ok: true }>("DELETE", "/api/entry" + qp(path), {}),
  rename: (from: RelPath, to: RelPath) => call<{ ok: true }>("POST", "/api/rename", { from, to }),
  mkdir: (path: RelPath) => call<{ ok: true }>("POST", "/api/dir", { path }),
  readComments: (path: RelPath) => call<CommentsFile>("GET", "/api/comments" + qp(path)),
  saveComments: (path: RelPath, data: CommentsFile) => call<{ ok: true }>("PUT", "/api/comments" + qp(path), data),
};

/** Suscripción a eventos del servidor; reconecta sola. Devuelve la función para cortar. */
export function subscribe(onEvent: (e: ServerEvent | { type: "hello" }) => void): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data));
    } catch {}
  };
  return () => es.close();
}
