// Genera los diagramas de ejemplo usando el MCP real, como lo haría un agente.
// Uso: node scripts/seed-example.ts [carpeta]   (por defecto: examples)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? path.join(here, "..", "examples"));
const client = new Client({ name: "seed", version: "1.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, "..", "server", "mcp.ts"), "--root", root] }));

async function call(name: string, args: Record<string, unknown>) {
  const res: any = await client.callTool({ name, arguments: args });
  const text = res.content?.map((c: any) => c.text).join("\n") ?? "";
  if (res.isError) throw new Error(`${name}: ${text}`);
  console.log(`✓ ${name} ${String(args.path ?? "")}`);
  return text;
}

const blue = "#a5d8ff", green = "#b2f2bb", yellow = "#ffec99", violet = "#d0bfff", gray = "#e9ecef";

await call("create_diagram", {
  path: "tienda/panorama.excalidraw",
  overwrite: true,
  direction: "LR",
  nodes: [
    { id: "web", label: "Web", backgroundColor: gray },
    { id: "app", label: "App mobile", backgroundColor: gray },
    { id: "gateway", label: "API Gateway", backgroundColor: violet },
    { id: "catalogo", label: "Catálogo", backgroundColor: blue, customData: { service: "catalog-api", team: "Catálogo" } },
    { id: "carrito", label: "Carrito", backgroundColor: blue, customData: { service: "cart-api", team: "Checkout" } },
    { id: "pagos", label: "Pagos", backgroundColor: green, customData: { service: "payments-api", team: "Pagos" } },
    { id: "envios", label: "Envíos", backgroundColor: blue, customData: { service: "shipping-api", team: "Logística" } },
    { id: "eventos", type: "ellipse", label: "Bus de eventos", backgroundColor: yellow },
  ],
  edges: [
    { from: "web", to: "gateway" },
    { from: "app", to: "gateway" },
    { from: "gateway", to: "catalogo" },
    { from: "gateway", to: "carrito" },
    { from: "carrito", to: "pagos", label: "cobrar" },
    { from: "pagos", to: "eventos", label: "pago aprobado", style: "dashed" },
    { from: "eventos", to: "envios", style: "dashed" },
  ],
});

await call("create_diagram", {
  path: "tienda/pagos/detalle.excalidraw",
  overwrite: true,
  direction: "TB",
  nodes: [
    { id: "api", label: "payments-api", backgroundColor: green },
    { id: "riesgo", label: "Motor de riesgo", backgroundColor: blue },
    { id: "adaptador", label: "Adaptador de procesadores", backgroundColor: blue },
    { id: "db", type: "ellipse", label: "DB de pagos", backgroundColor: yellow },
    { id: "procesador", label: "Procesador externo", backgroundColor: gray },
    { id: "ok", type: "diamond", label: "¿Aprobado?", backgroundColor: violet },
    { id: "evento", type: "ellipse", label: "Evento: pago aprobado", backgroundColor: yellow },
  ],
  edges: [
    { from: "api", to: "riesgo", label: "evaluar" },
    { from: "api", to: "db", label: "guardar intento" },
    { from: "riesgo", to: "adaptador" },
    { from: "adaptador", to: "procesador", label: "autorizar" },
    { from: "adaptador", to: "ok" },
    { from: "ok", to: "evento", label: "sí" },
  ],
});

await call("create_diagram", {
  path: "tienda/envios/detalle.excalidraw",
  overwrite: true,
  nodes: [
    { id: "consumidor", label: "Consumidor de eventos", backgroundColor: yellow },
    { id: "api", label: "shipping-api", backgroundColor: blue },
    { id: "ruteo", label: "Ruteo", backgroundColor: blue },
    { id: "carrier", label: "Transportista", backgroundColor: gray },
  ],
  edges: [
    { from: "consumidor", to: "api" },
    { from: "api", to: "ruteo" },
    { from: "ruteo", to: "carrier", label: "despachar" },
  ],
});

await call("link_element", { path: "tienda/panorama.excalidraw", id: "pagos", target_path: "tienda/pagos/detalle.excalidraw" });
await call("link_element", { path: "tienda/panorama.excalidraw", id: "envios", target_path: "tienda/envios/detalle.excalidraw" });
await call("link_element", { path: "tienda/pagos/detalle.excalidraw", id: "evento", target_path: "tienda/envios/detalle.excalidraw", target_element_id: "consumidor" });
await call("add_comment", { path: "tienda/pagos/detalle.excalidraw", element_id: "adaptador", author: "agente", text: "Falta definir el timeout y los reintentos contra el procesador." });
console.log(await call("read_diagram", { path: "tienda/panorama.excalidraw" }));
await client.close();
