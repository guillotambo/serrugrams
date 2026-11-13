// Sitio estático (server/site.ts): qué se publica, sin rutas absolutas, comentarios opcionales y una salida segura.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { existsSync, promises as fs, realpathSync } from "node:fs";
import { buildSite, publishable, SITE_MARKER } from "./site.ts";

let tmp: string;
let ui: string;
const diagram = (links: string[] = []) =>
  JSON.stringify({ type: "excalidraw", version: 2, source: "test", elements: links.map((l, i) => ({ id: "e" + i, type: "rectangle", x: 0, y: 0, width: 10, height: 10, link: l })), appState: {}, files: {} });
const comments = JSON.stringify({ version: 1, comments: [{ id: "c1", anchor: { x: 0, y: 0 }, author: "Ana", createdAt: "2026-01-01T00:00:00Z", resolved: false, text: "Duda", replies: [] }] });

before(async () => {
  tmp = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "serrugrams-site-test-")));
  ui = path.join(tmp, "ui");
  await fs.mkdir(path.join(ui, "assets"), { recursive: true });
  await fs.writeFile(path.join(ui, "index.html"), "<!doctype html><html><head><title>x</title></head><body></body></html>");
  await fs.writeFile(path.join(ui, "assets", "app.js"), "");

  // Repo con una carpeta de diagramas.
  const docs = path.join(tmp, "pagos", "docs", "diagramas");
  await fs.mkdir(path.join(docs, "api"), { recursive: true });
  await fs.writeFile(path.join(docs, "panorama.excalidraw"), diagram(["/api/detalle.excalidraw"]));
  await fs.writeFile(path.join(docs, "api", "detalle.excalidraw"), diagram());
  await fs.writeFile(path.join(docs, "panorama.excalidraw.comments.json"), comments);

  // Repo del que se publica un diagrama suelto: solo viaja lo que se alcanza por links.
  const repo = path.join(tmp, "envios");
  await fs.mkdir(path.join(repo, ".git"), { recursive: true });
  await fs.mkdir(path.join(repo, "otros"), { recursive: true });
  await fs.writeFile(path.join(repo, "suelto.excalidraw"), diagram(["/otros/linkeado.excalidraw"]));
  await fs.writeFile(path.join(repo, "otros", "linkeado.excalidraw"), diagram());
  await fs.writeFile(path.join(repo, "otros", "privado.excalidraw"), diagram());
});

after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

const readJson = async (p: string) => JSON.parse(await fs.readFile(p, "utf8"));

test("publica la UI marcada, el árbol y los diagramas, sin rutas del disco", async () => {
  const out = path.join(tmp, "out");
  const r = await buildSite({ inputs: [path.join(tmp, "pagos", "docs", "diagramas"), path.join(tmp, "envios", "suelto.excalidraw")], out, uiDir: ui });

  assert.deepEqual(r.refs, ["pagos", "envios"]);
  assert.equal(r.diagrams, 4);
  assert.equal(r.linked, 1);
  assert.equal(r.comments, 0);

  const html = await fs.readFile(path.join(out, "index.html"), "utf8");
  assert.match(html, /<meta name="serrugrams-site" content="1"/);
  assert.match(html, /noindex/);
  assert.ok(existsSync(path.join(out, "assets", "app.js")));
  assert.ok(existsSync(path.join(out, SITE_MARKER)));

  const tree = await readJson(path.join(out, "data", "tree.json"));
  const files = tree.entries.filter((e: any) => e.type === "file").map((e: any) => e.path).sort();
  assert.deepEqual(files, ["envios/otros/linkeado.excalidraw", "envios/suelto.excalidraw", "pagos/api/detalle.excalidraw", "pagos/panorama.excalidraw"]);
  assert.ok(!existsSync(path.join(out, "data", "files", "envios", "otros", "privado.excalidraw")));
  assert.equal(tree.entries.find((e: any) => e.path === "envios/otros/linkeado.excalidraw").hidden, true);

  // Ni una ruta absoluta en lo publicado.
  const raw = await fs.readFile(path.join(out, "data", "tree.json"), "utf8");
  assert.ok(!raw.includes(tmp), raw);
  assert.ok(!raw.includes(os.homedir()), raw);

  // Sin --comments no viajan ni los comentarios ni su conteo.
  assert.ok(!existsSync(path.join(out, "data", "files", "pagos", "panorama.excalidraw.comments.json")));
  assert.equal(tree.entries.find((e: any) => e.path === "pagos/panorama.excalidraw").openComments, undefined);
  const content = await readJson(path.join(out, "data", "files", "pagos", "panorama.excalidraw"));
  assert.equal(content.elements[0].link, "/api/detalle.excalidraw");
});

test("con comments publica los comentarios y rehace la salida anterior", async () => {
  const out = path.join(tmp, "out");
  await fs.writeFile(path.join(out, "viejo.txt"), "de una corrida anterior");
  const r = await buildSite({ inputs: [path.join(tmp, "pagos", "docs", "diagramas")], out, uiDir: ui, comments: true });
  assert.equal(r.comments, 1);
  assert.match(await fs.readFile(path.join(out, "index.html"), "utf8"), /<meta name="serrugrams-site" content="comments"/);
  // Un diagrama sin comentarios también lleva su archivo (vacío): la UI no se topa con un 404.
  assert.deepEqual((await readJson(path.join(out, "data", "files", "pagos", "api", "detalle.excalidraw.comments.json"))).comments, []);
  assert.ok(!existsSync(path.join(out, "viejo.txt")));
  assert.ok(!existsSync(path.join(out, "data", "files", "envios")));
  const c = await readJson(path.join(out, "data", "files", "pagos", "panorama.excalidraw.comments.json"));
  assert.equal(c.comments[0].text, "Duda");
  const tree = await readJson(path.join(out, "data", "tree.json"));
  assert.equal(tree.entries.find((e: any) => e.path === "pagos/panorama.excalidraw").openComments, 1);
});

test("no pisa una carpeta que no es un sitio", async () => {
  const out = path.join(tmp, "ajena");
  await fs.mkdir(out);
  await fs.writeFile(path.join(out, "importante.txt"), "no tocar");
  await assert.rejects(buildSite({ inputs: [path.join(tmp, "pagos", "docs", "diagramas")], out, uiDir: ui }), /no es un sitio/);
  assert.equal(await fs.readFile(path.join(out, "importante.txt"), "utf8"), "no tocar");
});

test("los escondidos solo entran por links, también encadenados", () => {
  const entries = [
    { path: "a/x.excalidraw", type: "file" as const, links: ["a/y.excalidraw"] },
    { path: "a/y.excalidraw", type: "file" as const, hidden: true, links: ["a/z.excalidraw"] },
    { path: "a/z.excalidraw", type: "file" as const, hidden: true },
    { path: "a/w.excalidraw", type: "file" as const, hidden: true },
  ];
  assert.deepEqual(publishable(entries).map((e) => e.path), ["a/x.excalidraw", "a/y.excalidraw", "a/z.excalidraw"]);
});
