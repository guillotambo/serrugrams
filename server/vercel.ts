// Entrada de la función de Vercel (modo nube): la API de server/cloud.ts sobre Vercel Blob.
// La empaqueta `serrugrams cloud build` en un solo archivo. La contraseña se lee al ejecutar, no al empaquetar.
import { getRequestListener } from "@hono/node-server";
import { BlobStore } from "./blobstore.ts";
import { cloudApp } from "./cloud.ts";
import { Workspace } from "./workspace.ts";

const app = cloudApp({
  ws: new Workspace(new BlobStore(process.env.SERRUGRAMS_BLOB_PREFIX || "diagramas")),
  password: process.env.SERRUGRAMS_PASSWORD,
  secure: true,
});

export default getRequestListener(app.fetch);
