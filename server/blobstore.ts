// Store sobre Vercel Blob (privado), para el modo nube. Solo lo importa la entrada de Vercel (server/vercel.ts):
// ni el modo local ni el MCP cargan el SDK.
//
// Credenciales: las que Vercel pone en el proyecto al conectar el store (BLOB_READ_WRITE_TOKEN, u OIDC).
import { copy, del, get, list, put } from "@vercel/blob";
import type { RelPath } from "../shared/types.ts";
import { FlatStore } from "./store.ts";

export class BlobStore extends FlatStore {
  readonly label: string;
  /** Todo vive bajo este prefijo del store, para poder guardar otras cosas al lado más adelante. */
  private prefix: string;

  constructor(prefix = "diagramas") {
    super();
    this.prefix = prefix.replace(/\/+$/, "") + "/";
    this.label = `vercel-blob:${prefix}`;
  }

  protected async keys() {
    const out: { key: RelPath; version: string }[] = [];
    let cursor: string | undefined;
    do {
      const page = await list({ prefix: this.prefix, cursor, limit: 1000 });
      for (const b of page.blobs) out.push({ key: b.pathname.slice(this.prefix.length), version: b.etag });
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor);
    return out;
  }

  /** Sin caché: una lectura vieja justo después de guardar haría que el editor vea un conflicto que no existe. */
  protected async get(key: RelPath) {
    const res = await get(this.prefix + key, { access: "private", useCache: false });
    if (!res || res.statusCode !== 200 || !res.stream) return null;
    return new Response(res.stream).text();
  }

  protected async put(key: RelPath, text: string) {
    await put(this.prefix + key, text, {
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "application/json",
      cacheControlMaxAge: 60,
    });
  }

  protected async del(keys: RelPath[]) {
    if (keys.length) await del(keys.map((k) => this.prefix + k));
  }

  protected async copy(from: RelPath, to: RelPath) {
    await copy(this.prefix + from, this.prefix + to, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
  }
}
