// Ubicar lo soltado desde Finder (server/locate.ts). Spotlight se reemplaza por una lista fija de candidatos.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs, realpathSync } from "node:fs";
import { locate } from "./locate.ts";

let tmp: string;
let a: string;
let b: string;
const all = () => Promise.resolve([path.join(a, "docs"), path.join(b, "docs"), path.join(a, "docs", "panorama.excalidraw"), path.join(b, "docs", "panorama.excalidraw")]);

before(async () => {
  tmp = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "serrugrams-locate-")));
  a = path.join(tmp, "a");
  b = path.join(tmp, "b");
  for (const [root, content, extra] of [[a, "{}", "x.excalidraw"], [b, "{ }", "y.excalidraw"]] as const) {
    await fs.mkdir(path.join(root, "docs"), { recursive: true });
    await fs.writeFile(path.join(root, "docs", "panorama.excalidraw"), content);
    await fs.writeFile(path.join(root, "docs", extra), "{}");
  }
});

after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test("un archivo se reconoce por nombre, tamaño y fecha", async () => {
  const st = await fs.stat(path.join(a, "docs", "panorama.excalidraw"));
  const found = await locate({ kind: "file", name: "panorama.excalidraw", size: st.size, mtime: Math.round(st.mtimeMs) }, all);
  assert.deepEqual(found, [path.join(a, "docs", "panorama.excalidraw")]);
  // Otra fecha: no es ese.
  assert.deepEqual(await locate({ kind: "file", name: "panorama.excalidraw", size: st.size, mtime: 0 }, all), []);
});

test("una carpeta se reconoce por su contenido; si coinciden dos, vuelven las dos", async () => {
  assert.deepEqual(await locate({ kind: "dir", name: "docs", children: ["panorama.excalidraw", "x.excalidraw"] }, all), [path.join(a, "docs")]);
  // Con menos hijos de los que tiene, no coincide (el navegador manda todos si son menos de 100).
  assert.deepEqual(await locate({ kind: "dir", name: "docs", children: ["panorama.excalidraw"] }, all), []);
  await fs.writeFile(path.join(b, "docs", "x.excalidraw"), "{}");
  await fs.rm(path.join(b, "docs", "y.excalidraw"));
  assert.deepEqual(await locate({ kind: "dir", name: "docs", children: ["panorama.excalidraw", "x.excalidraw"] }, all), [path.join(a, "docs"), path.join(b, "docs")]);
});

test("rechaza pedidos sin nombre o con barras", async () => {
  await assert.rejects(locate({ kind: "file", name: "", size: 1, mtime: 1 }, all));
  await assert.rejects(locate({ kind: "file", name: "../x", size: 1, mtime: 1 }, all));
  await assert.rejects(locate({ kind: "dir", name: "docs" } as any, all));
});
