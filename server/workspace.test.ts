// Workspace sobre los dos tipos de Store: disco y claves planas (la forma de Vercel Blob, acá en memoria).
// Las mismas reglas tienen que valer en los dos.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { emptyDiagram } from "../shared/types.ts";
import { DIR_MARKER, DiskStore, MemoryStore, type Store } from "./store.ts";
import { Workspace } from "./workspace.ts";

const linked = (...links: string[]) => ({ ...emptyDiagram(), elements: links.map((l, i) => ({ id: "e" + i, type: "rectangle", version: 1, link: l })) });
const comments = { version: 1 as const, comments: [{ id: "c1", anchor: { x: 0, y: 0 }, author: "a", createdAt: "2026-01-01T00:00:00Z", resolved: false, text: "x", replies: [] }] };

let tmp: string;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "serrugrams-ws-"));
});
after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

let n = 0;
const kinds: [string, () => Promise<Store>][] = [
  ["disco", async () => new DiskStore(await fs.mkdtemp(path.join(tmp, `d${n++}-`)))],
  ["claves planas", async () => new MemoryStore()],
];

for (const [name, make] of kinds) {
  describe(`Workspace en ${name}`, () => {
    test("leer, escribir y detectar conflictos", async () => {
      const ws = new Workspace(await make());
      await assert.rejects(ws.readDiagram("a.excalidraw"), { status: 404 });
      const h1 = await ws.writeDiagram("a/b.excalidraw", emptyDiagram(), { mustNotExist: true });
      await assert.rejects(ws.writeDiagram("a/b.excalidraw", emptyDiagram(), { mustNotExist: true }), { status: 409 });
      const { hash } = await ws.readDiagram("a/b.excalidraw");
      assert.equal(hash, h1);
      await ws.writeDiagram("a/b.excalidraw", linked("/c.excalidraw"), { baseHash: h1 });
      await assert.rejects(ws.writeDiagram("a/b.excalidraw", emptyDiagram(), { baseHash: h1 }), { status: 409 });
    });

    test("árbol: orden, links, comentarios y carpetas", async () => {
      const store = await make();
      const ws = new Workspace(store);
      await ws.writeDiagram("panorama.excalidraw", linked("/pagos/detalle.excalidraw"));
      await ws.writeDiagram("pagos/detalle.excalidraw", emptyDiagram());
      await ws.writeComments("pagos/detalle.excalidraw", comments);
      await ws.mkdir("vacia");
      await store.write("codigo/x.ts", "// no es un diagrama");
      await store.write(".serrugrams/trash/x/viejo.excalidraw", "{}");
      const tree = await ws.tree();
      // "codigo" no tiene diagramas y la papelera es oculta: ninguna de las dos se lista.
      assert.deepEqual(tree.map((e) => `${e.type}:${e.path}`), ["dir:pagos", "file:pagos/detalle.excalidraw", "file:panorama.excalidraw", "dir:vacia"]);
      assert.deepEqual(tree.find((e) => e.path === "panorama.excalidraw")?.links, ["pagos/detalle.excalidraw"]);
      assert.equal(tree.find((e) => e.path === "pagos/detalle.excalidraw")?.openComments, 1);
    });

    test("una carpeta vacía deja de estarlo al escribir adentro", async () => {
      const store = await make();
      const ws = new Workspace(store);
      await ws.mkdir("nueva");
      await ws.writeDiagram("nueva/x.excalidraw", emptyDiagram());
      assert.deepEqual((await ws.tree()).map((e) => e.path), ["nueva", "nueva/x.excalidraw"]);
      if (store instanceof MemoryStore) assert.ok(!store.dump().includes(`nueva/${DIR_MARKER}`));
    });

    test("renombrar un diagrama mueve sus comentarios y actualiza los links", async () => {
      const ws = new Workspace(await make());
      await ws.writeDiagram("panorama.excalidraw", linked("/pagos/detalle.excalidraw#e0"));
      await ws.writeDiagram("pagos/detalle.excalidraw", emptyDiagram());
      await ws.writeComments("pagos/detalle.excalidraw", comments);
      await ws.rename("pagos/detalle.excalidraw", "pagos/flujo.excalidraw");
      assert.equal(await ws.exists("pagos/detalle.excalidraw"), false);
      assert.equal((await ws.readComments("pagos/flujo.excalidraw")).comments.length, 1);
      assert.equal((await ws.readComments("pagos/detalle.excalidraw")).comments.length, 0);
      assert.equal((await ws.readDiagram("panorama.excalidraw")).content.elements[0].link, "/pagos/flujo.excalidraw#e0");
      await assert.rejects(ws.rename("no-existe.excalidraw", "otro.excalidraw"), { status: 404 });
      await assert.rejects(ws.rename("panorama.excalidraw", "pagos/flujo.excalidraw"), { status: 409 });
    });

    test("renombrar una carpeta mueve todo lo de adentro", async () => {
      const ws = new Workspace(await make());
      await ws.writeDiagram("panorama.excalidraw", linked("/pagos/detalle.excalidraw"));
      await ws.writeDiagram("pagos/detalle.excalidraw", emptyDiagram());
      await ws.writeComments("pagos/detalle.excalidraw", comments);
      await ws.rename("pagos", "cobros");
      assert.deepEqual((await ws.tree()).map((e) => e.path), ["cobros", "cobros/detalle.excalidraw", "panorama.excalidraw"]);
      assert.equal((await ws.readComments("cobros/detalle.excalidraw")).comments.length, 1);
      assert.equal((await ws.readDiagram("panorama.excalidraw")).content.elements[0].link, "/cobros/detalle.excalidraw");
    });

    test("la papelera saca del árbol sin borrar", async () => {
      const store = await make();
      const ws = new Workspace(store);
      await ws.writeDiagram("x.excalidraw", emptyDiagram());
      await ws.writeComments("x.excalidraw", comments);
      await ws.trash("x.excalidraw");
      assert.deepEqual(await ws.tree(), []);
      assert.equal(await ws.exists("x.excalidraw"), false);
      if (store instanceof MemoryStore) assert.equal(store.dump().filter((k) => k.startsWith(".serrugrams/trash/")).length, 2);
    });

    test("rechaza rutas que salen de la raíz o tocan carpetas ignoradas", async () => {
      const ws = new Workspace(await make());
      for (const bad of ["../x.excalidraw", "/x.excalidraw", "a/../../x.excalidraw", ".git/x.excalidraw", ".serrugrams/trash/x.excalidraw", "a\\b.excalidraw", "a//b.excalidraw", ""]) {
        await assert.rejects(ws.writeDiagram(bad, emptyDiagram()), { status: 400 }, bad);
      }
      await assert.rejects(ws.readDiagram("x.txt"), { status: 400 });
    });
  });
}
