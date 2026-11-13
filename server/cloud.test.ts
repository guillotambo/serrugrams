// API de la nube (server/cloud.ts) por HTTP de verdad, sobre un store en memoria: contraseña, defensas y operaciones.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { serve, type ServerType } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { emptyDiagram } from "../shared/types.ts";
import { cloudApp, SESSION_COOKIE } from "./cloud.ts";
import { MemoryStore } from "./store.ts";
import { Workspace } from "./workspace.ts";

const servers: ServerType[] = [];
const MCP_TOKEN = "token-de-test";
function start(password: string | undefined, mcpToken?: string): Promise<string> {
  const ws = new Workspace(new MemoryStore());
  const app = cloudApp({ ws, password, mcpToken, workflow: "# Diagramar un sistema\n\nTexto de la skill." });
  return new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(`http://127.0.0.1:${info.port}`));
    servers.push(s);
  });
}
after(() => servers.forEach((s) => s.close()));

let base: string;
let cookie = "";
before(async () => {
  base = await start("secreto-de-test", MCP_TOKEN);
});

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, res };
}

test("sin contraseña configurada no sirve nada", async () => {
  const other = await start(undefined);
  const res = await fetch(other + "/api/tree");
  assert.equal(res.status, 503);
  const login = await fetch(other + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "" }) });
  assert.equal(login.status, 503);
});

test("todo pide sesión, también las lecturas", async () => {
  for (const [m, p, b] of [
    ["GET", "/api/tree"],
    ["GET", "/api/session"],
    ["GET", "/api/file?path=nube/a.excalidraw"],
    ["GET", "/api/comments?path=nube/a.excalidraw"],
    ["PUT", "/api/file?path=nube/a.excalidraw", { content: emptyDiagram() }],
    ["POST", "/api/file", { path: "nube/a.excalidraw" }],
    ["DELETE", "/api/entry?path=nube/a.excalidraw", {}],
    ["POST", "/api/rename", { from: "nube/a.excalidraw", to: "nube/b.excalidraw" }],
    ["POST", "/api/dir", { path: "nube/x" }],
    ["PUT", "/api/comments?path=nube/a.excalidraw", { version: 1, comments: [] }],
  ] as [string, string, unknown?][]) {
    assert.equal((await call(m, p, b)).status, 401, `${m} ${p}`);
  }
});

test("contraseña incorrecta no entra; la correcta deja una cookie de sesión", async () => {
  assert.equal((await call("POST", "/api/login", { password: "otra" })).status, 401);
  const ok = await call("POST", "/api/login", { password: "secreto-de-test" });
  assert.equal(ok.status, 200);
  const set = ok.res.headers.get("set-cookie") ?? "";
  assert.match(set, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(set, /HttpOnly/i);
  cookie = set.split(";")[0];
  assert.equal((await call("GET", "/api/session")).status, 200);
});

test("escrituras: solo JSON y del mismo origen", async () => {
  assert.equal((await call("POST", "/api/dir", undefined, { "content-type": "text/plain" })).status, 415);
  assert.equal((await call("POST", "/api/dir", { path: "nube/x" }, { origin: "https://otra.web" })).status, 403);
  assert.equal((await call("POST", "/api/dir", { path: "nube/x" }, { origin: base })).status, 200);
});

test("crear, leer, guardar con conflicto, renombrar y comentar", async () => {
  const tree0 = (await call("GET", "/api/tree")).json;
  assert.deepEqual(tree0.refs.map((r: any) => r.id), ["nube"]);
  assert.ok(tree0.entries.some((e: any) => e.path === "nube" && e.type === "dir"));

  assert.equal((await call("POST", "/api/file", { path: "nube/panorama.excalidraw" })).status, 200);
  assert.equal((await call("POST", "/api/file", { path: "nube/panorama.excalidraw" })).status, 409);
  const read = (await call("GET", "/api/file?path=nube/panorama.excalidraw")).json;
  const saved = await call("PUT", "/api/file?path=nube/panorama.excalidraw", { content: { ...emptyDiagram(), elements: [{ id: "a", type: "rectangle", link: "/x/detalle.excalidraw" }] }, baseHash: read.hash });
  assert.equal(saved.status, 200);
  assert.equal((await call("PUT", "/api/file?path=nube/panorama.excalidraw", { content: emptyDiagram(), baseHash: read.hash })).status, 409);

  await call("POST", "/api/file", { path: "nube/x/detalle.excalidraw" });
  await call("PUT", "/api/comments?path=nube/x/detalle.excalidraw", { version: 1, comments: [{ id: "c", anchor: { x: 0, y: 0 }, author: "g", createdAt: "2026-01-01T00:00:00Z", resolved: false, text: "hola", replies: [] }] });
  assert.equal((await call("POST", "/api/rename", { from: "nube/x", to: "nube/y" })).status, 200);
  const tree = (await call("GET", "/api/tree")).json;
  const pan = tree.entries.find((e: any) => e.path === "nube/panorama.excalidraw");
  assert.deepEqual(pan.links, ["nube/y/detalle.excalidraw"]);
  assert.equal(tree.entries.find((e: any) => e.path === "nube/y/detalle.excalidraw").openComments, 1);
  assert.equal((await call("GET", "/api/comments?path=nube/y/detalle.excalidraw")).json.comments[0].text, "hola");

  assert.equal((await call("DELETE", "/api/entry?path=nube/y/detalle.excalidraw", {})).status, 200);
  assert.ok(!(await call("GET", "/api/tree")).json.entries.some((e: any) => e.path === "nube/y/detalle.excalidraw"));
});

test("rutas fuera de la nube o con trucos se rechazan", async () => {
  assert.equal((await call("GET", "/api/file?path=otra/a.excalidraw")).status, 404);
  assert.equal((await call("GET", "/api/file?path=nube/../a.excalidraw")).status, 400);
  assert.equal((await call("GET", "/api/file?path=nube/.serrugrams/trash/a.excalidraw")).status, 400);
  assert.equal((await call("POST", "/api/file", { path: "nube//a.excalidraw" })).status, 400);
});

test("no existen los endpoints que solo sirven en local", async () => {
  for (const p of ["/api/refs", "/api/pick", "/api/locate", "/api/complete?prefix=~", "/api/events"]) {
    assert.equal((await call("GET", p)).status, 404, p);
  }
});

// --- MCP remoto ---

async function mcpClient(token: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + "/api/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

test("el MCP pide su token: sin token o con otro, 401; la cookie de la app no alcanza", async () => {
  assert.equal((await fetch(base + "/api/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);
  assert.equal((await fetch(base + "/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer otro" }, body: "{}" })).status, 401);
  assert.equal((await fetch(base + "/api/mcp", { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" })).status, 401);
  await assert.rejects(mcpClient("otro"));
});

test("sin token configurado, el MCP está cerrado", async () => {
  const other = await start("x");
  const res = await fetch(other + "/api/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " }, body: "{}" });
  assert.equal(res.status, 503);
});

test("el MCP remoto crea y lee diagramas en el mismo store que la app", async () => {
  const client = await mcpClient(MCP_TOKEN);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  for (const t of ["list_diagrams", "read_diagram", "create_diagram", "add_comment"]) assert.ok(tools.includes(t), t);
  const created = await client.callTool({
    name: "create_diagram",
    arguments: { path: "remoto/panorama.excalidraw", nodes: [{ id: "api", label: "API" }, { id: "db", label: "DB", type: "ellipse" }], edges: [{ from: "api", to: "db", label: "SQL" }] },
  });
  assert.ok(!created.isError, JSON.stringify(created.content));
  const text = (created.content as any[])[0].text as string;
  assert.ok(!text.includes("addToView"), "en la nube no hay vista local que sumar");
  assert.equal(JSON.parse(text).open, `${base}/#/nube/remoto/panorama.excalidraw`);
  // Lo ve la app (misma API, con cookie).
  const tree = (await call("GET", "/api/tree")).json;
  assert.ok(tree.entries.some((e: any) => e.path === "nube/remoto/panorama.excalidraw"));
  const listed = await client.callTool({ name: "list_diagrams", arguments: {} });
  assert.match((listed.content as any[])[0].text, /remoto\/panorama\.excalidraw/);
  await client.close();
});

test("el MCP remoto ofrece la skill como el prompt diagramar", async () => {
  const client = await mcpClient(MCP_TOKEN);
  assert.ok((await client.listPrompts()).prompts.some((p) => p.name === "diagramar"));
  const prompt = await client.getPrompt({ name: "diagramar", arguments: { pedido: "el checkout" } });
  const text = (prompt.messages[0].content as any).text as string;
  assert.match(text, /Texto de la skill/);
  assert.match(text, /el checkout/);
  await client.close();
});
