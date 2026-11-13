// Test end-to-end: levanta `node server/mcp.ts --root <tmp>` y lo maneja con el Client real del SDK.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "mcp.ts");
let root: string;
let client: Client;

const readJson = async (rel: string) => JSON.parse(await fs.readFile(path.join(root, rel), "utf8"));

async function call(name: string, args: Record<string, unknown> = {}) {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.map((c: any) => c.text).join("\n") ?? "";
  return { isError: !!res.isError, text, json: () => JSON.parse(text) };
}
async function callOk(name: string, args: Record<string, unknown> = {}) {
  const r = await call(name, args);
  assert.ok(!r.isError, `${name} falló: ${r.text}`);
  return r;
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "serrugrams-mcp-"));
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath, "--root", root], stderr: "pipe" });
  client = new Client({ name: "serrugrams-test", version: "0.0.0" });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test("expone tools, prompt e instrucciones", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "add_comment", "add_elements", "create_diagram", "delete_elements", "link_element", "list_comments",
    "list_diagrams", "read_diagram", "rename_diagram", "reply_comment", "resolve_comment", "update_element",
  ]);
  const create = tools.find((t) => t.name === "create_diagram")!;
  assert.ok((create.inputSchema as any).properties.nodes, "inputSchema con properties reales");
  assert.ok((create.inputSchema as any).properties.nodes.items.properties.customData);
  assert.match(client.getInstructions() ?? "", /customData/);
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.some((p) => p.name === "system_design_conventions"));
  // La skill viaja también como prompt, sin su encabezado YAML y con el pedido al final.
  assert.ok(prompts.some((p) => p.name === "diagramar"));
  const prompt: any = await client.getPrompt({ name: "diagramar", arguments: { pedido: "cómo funciona el checkout" } });
  const text: string = prompt.messages[0].content.text;
  assert.ok(!text.startsWith("---"), "sin frontmatter");
  assert.match(text, /panorama\.excalidraw/);
  assert.match(text, /## Pedido\n\ncómo funciona el checkout$/);
});

test("una raíz relativa se resuelve desde la raíz del repo y no se crea hasta escribir", async () => {
  // Como con el MCP global (`--root docs/diagramas`) lanzado desde una subcarpeta de un repo cualquiera.
  const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "serrugrams-repo-")));
  const sub = path.join(repo, "src", "api");
  await fs.mkdir(path.join(repo, ".git"));
  await fs.mkdir(sub, { recursive: true });
  const expected = path.join(repo, "docs", "diagramas");
  const exists = (p: string) => fs.access(p).then(() => true, () => false);
  const c = new Client({ name: "serrugrams-test-root", version: "0.0.0" });
  try {
    await c.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath, "--root", "docs/diagramas"], cwd: sub, stderr: "pipe" }));
    const run = async (name: string, args: Record<string, unknown> = {}) => {
      const res: any = await c.callTool({ name, arguments: args });
      return { isError: !!res.isError, text: res.content.map((x: any) => x.text).join("\n") };
    };

    let r = await run("list_diagrams");
    assert.ok(!r.isError, r.text);
    assert.ok(r.text.includes(expected), `la raíz es ${expected}: ${r.text}`);
    assert.ok((await run("read_diagram", { path: "panorama.excalidraw" })).isError);
    assert.ok((await run("list_comments", { path: "panorama.excalidraw" })).isError);
    assert.ok(!(await exists(path.join(repo, "docs"))), "arrancar, listar y leer no crean la carpeta");
    assert.ok(!(await exists(path.join(sub, "docs"))), "ni la crean en el directorio de arranque");

    r = await run("create_diagram", { path: "panorama.excalidraw", nodes: [{ id: "api", label: "API" }] });
    assert.ok(!r.isError, r.text);
    assert.ok(await exists(path.join(expected, "panorama.excalidraw")), "el primer diagrama crea la carpeta");
    const created = JSON.parse(r.text);
    assert.equal(created.root, expected);
    assert.ok(created.addToView.endsWith(expected), created.addToView);
    assert.match(created.addToView, /bin\/serrugrams\.js/);
    assert.equal(JSON.parse((await run("list_diagrams")).text).addToView, created.addToView);
  } finally {
    await c.close();
    await fs.rm(repo, { recursive: true, force: true });
  }
});

test("flujo completo: crear, leer, agregar, actualizar, linkear, comentar, renombrar, borrar", async () => {
  let r = await callOk("list_diagrams");
  assert.match(r.text, /No diagrams yet/);

  r = await callOk("create_diagram", {
    path: "overview.excalidraw",
    nodes: [
      { id: "web", label: "Web" },
      { id: "api", label: "API", customData: { service: "api", team: "core" } },
      { id: "db", type: "ellipse", label: "Postgres" },
    ],
    edges: [{ from: "web", to: "api", label: "HTTPS" }, { from: "api", to: "db" }],
  });
  assert.deepEqual(r.json().nodes, { web: "web", api: "api", db: "db" });
  let file = await readJson("overview.excalidraw");
  assert.equal(file.type, "excalidraw");
  assert.equal(file.elements.filter((e: any) => e.type === "arrow").length, 2);

  // Crear de nuevo sin overwrite falla como error de tool.
  r = await call("create_diagram", { path: "overview.excalidraw", nodes: [] });
  assert.ok(r.isError);
  assert.match(r.text, /already exists/);

  r = await callOk("read_diagram", { path: "/overview.excalidraw" });
  const s = r.json();
  assert.equal(s.nodes.length, 3);
  assert.equal(s.texts.length, 0, "los labels no aparecen como textos sueltos");
  assert.deepEqual(s.edges.find((e: any) => e.label === "HTTPS") && [s.edges[0].from, s.edges[0].to], ["web", "api"]);
  assert.ok(!("elements" in s));
  assert.ok("elements" in (await callOk("read_diagram", { path: "overview.excalidraw", raw: true })).json());

  r = await callOk("add_elements", { path: "overview.excalidraw", nodes: [{ id: "queue", label: "Kafka" }], edges: [{ from: "api", to: "queue", style: "dashed", label: "publishes" }] });
  file = await readJson("overview.excalidraw");
  const q = file.elements.find((e: any) => e.id === "queue");
  const others = file.elements.filter((e: any) => ["web", "api", "db"].includes(e.id));
  for (const o of others) {
    const overlap = q.x < o.x + o.width && o.x < q.x + q.width && q.y < o.y + o.height && o.y < q.y + q.height;
    assert.ok(!overlap, `queue se superpone con ${o.id}`);
  }

  // Edición fuera de banda (como la UI) entre dos llamadas: no se pisa.
  file = await readJson("overview.excalidraw");
  file.elements.find((e: any) => e.id === "db").backgroundColor = "#ffec99";
  await fs.writeFile(path.join(root, "overview.excalidraw"), JSON.stringify(file));

  const apiBefore = file.elements.find((e: any) => e.id === "api");
  await callOk("update_element", { path: "overview.excalidraw", id: "api", patch: { y: apiBefore.y + 400, label: "API Gateway", customData: { repo: "org/api" } } });
  file = await readJson("overview.excalidraw");
  assert.equal(file.elements.find((e: any) => e.id === "db").backgroundColor, "#ffec99", "se conservó la edición externa");
  const api = file.elements.find((e: any) => e.id === "api");
  assert.equal(api.y, apiBefore.y + 400);
  assert.deepEqual(api.customData, { service: "api", team: "core", repo: "org/api" });
  assert.equal(file.elements.find((e: any) => e.containerId === "api").originalText, "API Gateway");
  for (const a of file.elements.filter((e: any) => e.type === "arrow" && e.endBinding?.elementId === "api")) {
    const endY = a.y + a.points[a.points.length - 1][1];
    assert.ok(Math.abs(endY - (api.y + api.height / 2)) < api.height, "la flecha sigue al nodo movido");
  }

  // Link a destino inexistente falla; con create_target lo crea.
  r = await call("link_element", { path: "overview.excalidraw", id: "api", target_path: "api/detail.excalidraw" });
  assert.ok(r.isError);
  await callOk("link_element", { path: "overview.excalidraw", id: "api", target_path: "api/detail.excalidraw", create_target: true });
  file = await readJson("overview.excalidraw");
  assert.equal(file.elements.find((e: any) => e.id === "api").link, "/api/detail.excalidraw");
  assert.equal((await readJson("api/detail.excalidraw")).elements.length, 0);

  await callOk("create_diagram", { path: "api/detail.excalidraw", overwrite: true, nodes: [{ id: "router", label: "Router" }, { id: "auth", label: "Auth" }], edges: [{ from: "router", to: "auth" }], direction: "TB" });
  await callOk("link_element", { path: "overview.excalidraw", id: "api", target_path: "api/detail.excalidraw", target_element_id: "router" });
  assert.equal((await readJson("overview.excalidraw")).elements.find((e: any) => e.id === "api").link, "/api/detail.excalidraw#router");
  r = await call("link_element", { path: "overview.excalidraw", id: "api", target_path: "api/detail.excalidraw", target_element_id: "nope" });
  assert.ok(r.isError);

  // Comentarios.
  r = await callOk("add_comment", { path: "overview.excalidraw", text: "¿Rate limiting?", element_id: "api", author: "ana" });
  const cid = r.json().added;
  await callOk("add_comment", { path: "overview.excalidraw", text: "Falta CDN", x: 10, y: 20 });
  await callOk("reply_comment", { path: "overview.excalidraw", comment_id: cid, text: "Sí, en el gateway" });
  let comments = await readJson("overview.excalidraw.comments.json");
  assert.equal(comments.version, 1);
  const c0 = comments.comments.find((c: any) => c.id === cid);
  assert.equal(c0.author, "ana");
  assert.equal(c0.anchor.elementId, "api");
  assert.deepEqual(c0.anchor.offset, { x: api.width, y: 0 });
  assert.equal(c0.anchor.x, api.x + api.width);
  assert.equal(c0.anchor.y, api.y);
  assert.equal(c0.replies[0].author, "agent");
  assert.equal(c0.resolved, false);
  const c1 = comments.comments.find((c: any) => c.id !== cid);
  assert.deepEqual(c1.anchor, { x: 10, y: 20 });
  assert.equal(c1.author, "agent");

  r = await callOk("list_diagrams");
  const ov = r.json().diagrams.find((d: any) => d.path === "overview.excalidraw");
  assert.deepEqual(ov.linksTo, ["api/detail.excalidraw"]);
  assert.equal(ov.openComments, 2);

  await callOk("resolve_comment", { path: "overview.excalidraw", comment_id: cid });
  comments = await readJson("overview.excalidraw.comments.json");
  assert.equal(comments.comments.find((c: any) => c.id === cid).resolved, true);
  r = await callOk("list_comments", { path: "overview.excalidraw" });
  const listed = r.json().comments;
  assert.equal(listed[0].resolved, false, "abiertos primero");
  assert.equal(listed.find((c: any) => c.id === cid).elementLabel, "API Gateway");
  assert.equal(r.json().comments.length, 2);
  assert.equal((await callOk("list_comments", { path: "overview.excalidraw", include_resolved: false })).json().comments.length, 1);

  // Renombrar actualiza links entrantes y mueve comentarios.
  r = await callOk("rename_diagram", { from: "api/detail.excalidraw", to: "gateway/detail.excalidraw" });
  assert.deepEqual(r.json().linksUpdatedIn, ["overview.excalidraw"], r.text);
  assert.equal((await readJson("overview.excalidraw")).elements.find((e: any) => e.id === "api").link, "/gateway/detail.excalidraw#router");

  // Borrar.
  r = await callOk("delete_elements", { path: "overview.excalidraw", ids: ["db"] });
  file = await readJson("overview.excalidraw");
  assert.ok(!file.elements.some((e: any) => e.id === "db" || e.containerId === "db"));
  assert.ok(!file.elements.some((e: any) => e.type === "arrow" && (e.startBinding?.elementId === "db" || e.endBinding?.elementId === "db")));
  assert.ok(!file.elements.find((e: any) => e.id === "api").boundElements.some((b: any) => !file.elements.some((e: any) => e.id === b.id)));
});

test("errores devuelven isError y el servidor sigue respondiendo", async () => {
  let r = await call("read_diagram", { path: "../fuera.excalidraw" });
  assert.ok(r.isError);
  r = await call("read_diagram", { path: "no-existe.excalidraw" });
  assert.ok(r.isError);
  assert.match(r.text, /No existe/);
  r = await call("read_diagram", { path: "foo.txt" });
  assert.ok(r.isError);
  r = await call("add_elements", { path: "overview.excalidraw", edges: [{ from: "web", to: "ghost" }] });
  assert.ok(r.isError);
  assert.match(r.text, /ghost/);
  r = await call("update_element", { path: "overview.excalidraw", id: "ghost", patch: { x: 1 } });
  assert.ok(r.isError);
  r = await callOk("list_diagrams");
  assert.ok(r.json().diagrams.length >= 2);
});
