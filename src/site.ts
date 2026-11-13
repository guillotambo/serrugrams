// Modo sitio: la interfaz servida como archivos estáticos (`serrugrams site`), en solo lectura. Los datos salen de
// data/ en vez de /api. Ver src/mode.ts.
import { COMMENTS_SUFFIX, type CommentsFile, type FileResponse, type RelPath, type TreeResponse } from "../shared/types.ts";

import { SITE_COMMENTS } from "./mode.ts";
export { SITE } from "./mode.ts";

const fileUrl = (path: RelPath) => "data/files/" + path.split("/").map(encodeURIComponent).join("/");

async function getJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const siteData = {
  tree: async (): Promise<TreeResponse> => (await getJson<TreeResponse>("data/tree.json")) ?? { refs: [], entries: [] },
  readFile: async (path: RelPath): Promise<FileResponse | null> => {
    const content = await getJson<FileResponse["content"]>(fileUrl(path));
    return content && { path, content, hash: "site" };
  },
  /** Sin archivo de comentarios (no se publicaron, o no hay): lista vacía. */
  readComments: async (path: RelPath): Promise<CommentsFile> =>
    (SITE_COMMENTS ? await getJson<CommentsFile>(fileUrl(path) + COMMENTS_SUFFIX).catch(() => null) : null) ?? { version: 1, comments: [] },
};
