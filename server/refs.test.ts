// Referencias de la vista (server/refs.ts) y resolución de links entre rutas globales (shared/types.ts).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs, realpathSync } from "node:fs";
import { Refs } from "./refs.ts";
import { linkPathFor, resolveLinkTarget } from "../shared/types.ts";

let tmp: string;
let refs: Refs;
const diagram = (links: string[] = []) =>
  JSON.stringify({ type: "excalidraw", version: 2, elements: links.map((link, i) => ({ id: `e${i}`, type: "rectangle", link })), appState: {}, files: {} });

before(async () => {
  tmp = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "serrugrams-refs-")));
  // Un repo con los diagramas en docs/diagramas y links relativos a esa carpeta, como los escribe el MCP.
  const docs = path.join(tmp, "pagos", "docs", "diagramas");
  await fs.mkdir(path.join(tmp, "pagos", ".git"), { recursive: true });
  await fs.mkdir(path.join(docs, "detalle"), { recursive: true });
  await fs.writeFile(path.join(docs, "panorama.excalidraw"), diagram(["/detalle/cobros.excalidraw#x"]));
  await fs.writeFile(path.join(docs, "detalle", "cobros.excalidraw"), diagram(["/panorama.excalidraw"]));
  await fs.mkdir(path.join(tmp, "otro"), { recursive: true });
  await fs.writeFile(path.join(tmp, "otro", "panorama.excalidraw"), diagram());
  refs = new Refs(path.join(tmp, "home", "workspace.json"), () => {});
  await refs.start();
});

after(async () => {
  await refs?.close();
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test("resolveLinkTarget prueba desde la raíz hacia la carpeta del origen", () => {
  const files = new Set(["r/docs/diagramas/a.excalidraw", "r/docs/diagramas/x/b.excalidraw", "r/a.excalidraw"]);
  const exists = (p: string) => files.has(p);
  // Gana la raíz si existe ahí.
  assert.equal(resolveLinkTarget("r/docs/diagramas/x/b.excalidraw", "a.excalidraw", exists), "r/a.excalidraw");
  // Si no, la primera carpeta intermedia donde existe.
  assert.equal(resolveLinkTarget("r/docs/diagramas/x/b.excalidraw", "x/b.excalidraw", exists), "r/docs/diagramas/x/b.excalidraw");
  // Si no existe en ningún lado, la de la raíz (que no abre).
  assert.equal(resolveLinkTarget("r/docs/z.excalidraw", "nada.excalidraw", exists), "r/nada.excalidraw");
});

test("linkPathFor escribe relativo a la base y no cruza referencias", () => {
  assert.equal(linkPathFor("r/docs/diagramas/x/b.excalidraw", "r/docs/diagramas"), "x/b.excalidraw");
  assert.equal(linkPathFor("r/a.excalidraw", "r/docs/diagramas"), "a.excalidraw");
  assert.equal(linkPathFor("otra/a.excalidraw", "r"), null);
});

test("carpeta: el nombre sale del repo y los links se resuelven", async () => {
  const ref = await refs.add(path.join(tmp, "pagos", "docs", "diagramas"));
  assert.equal(ref.id, "pagos");
  assert.equal(ref.kind, "folder");
  const { entries } = await refs.tree();
  const panorama = entries.find((e) => e.path === "pagos/panorama.excalidraw");
  assert.deepEqual(panorama?.links, ["pagos/detalle/cobros.excalidraw"]);
  // Sumarla de nuevo no la duplica.
  assert.equal((await refs.add(path.join(tmp, "pagos", "docs", "diagramas"))).id, "pagos");
});

test("diagrama suelto: raíz en el repo, lo demás escondido pero alcanzable por link", async () => {
  const ref = await refs.add(path.join(tmp, "pagos", "docs", "diagramas", "detalle", "cobros.excalidraw"));
  assert.equal(ref.kind, "file");
  assert.equal(ref.id, "pagos-2");
  assert.equal(ref.root, path.join(tmp, "pagos"));
  assert.equal(ref.file, "pagos-2/docs/diagramas/detalle/cobros.excalidraw");
  const { entries } = await refs.tree();
  const own = entries.filter((e) => e.path.startsWith("pagos-2/"));
  assert.deepEqual(own.filter((e) => !e.hidden).map((e) => e.path), [ref.file]);
  // Su link "/panorama.excalidraw" es relativo a docs/diagramas, no a la raíz del repo.
  assert.deepEqual(own.find((e) => e.path === ref.file)?.links, ["pagos-2/docs/diagramas/panorama.excalidraw"]);
  const { rel } = refs.locate("pagos-2/docs/diagramas/panorama.excalidraw");
  assert.equal(rel, "docs/diagramas/panorama.excalidraw");
});

test("renombrar en un diagrama suelto reescribe los links con su misma base", async () => {
  // La raíz es el repo, pero los links son relativos a docs/diagramas.
  const { ws, rel } = refs.locate("pagos-2/docs/diagramas/panorama.excalidraw");
  await ws.rename(rel, "docs/diagramas/vista-general.excalidraw");
  const cobros = JSON.parse(await fs.readFile(path.join(tmp, "pagos", "docs", "diagramas", "detalle", "cobros.excalidraw"), "utf8"));
  assert.equal(cobros.elements[0].link, "/vista-general.excalidraw");
  await ws.rename("docs/diagramas/vista-general.excalidraw", rel);
  const back = JSON.parse(await fs.readFile(path.join(tmp, "pagos", "docs", "diagramas", "detalle", "cobros.excalidraw"), "utf8"));
  assert.equal(back.elements[0].link, "/panorama.excalidraw");
});

test("renombrar, mover en disco y quitar", async () => {
  await refs.add(path.join(tmp, "otro"));
  assert.equal(await refs.rename("otro", "mi vista"), "mi vista");
  assert.ok(refs.info().some((r) => r.id === "mi vista"));
  await assert.rejects(refs.rename("mi vista", "pagos"), /Ya hay/);

  const from = path.join(tmp, "pagos", "docs", "diagramas", "detalle", "cobros.excalidraw");
  const to = path.join(tmp, "pagos", "docs", "diagramas", "detalle", "cobranzas.excalidraw");
  await fs.rename(from, to);
  await refs.moved(from, to);
  assert.equal(refs.info().find((r) => r.id === "pagos-2")?.path, to);

  await refs.remove("mi vista");
  const saved = JSON.parse(await fs.readFile(refs.file, "utf8"));
  assert.deepEqual(saved.refs.map((r: any) => r.id), ["pagos", "pagos-2"]);
});

test("una referencia perdida queda marcada y no se puede abrir", async () => {
  await fs.rename(path.join(tmp, "pagos"), path.join(tmp, "pagos-movido"));
  const { refs: info } = await refs.tree();
  assert.ok(info.find((r) => r.id === "pagos")?.missing);
  assert.throws(() => refs.locate("pagos/panorama.excalidraw"), /No se encuentra/);
  await fs.rename(path.join(tmp, "pagos-movido"), path.join(tmp, "pagos"));
  const back = await refs.tree();
  assert.ok(!back.refs.find((r) => r.id === "pagos")?.missing);
});
