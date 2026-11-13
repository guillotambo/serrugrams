# MCP de Serrugrams

Servidor MCP (stdio) para que un agente (Claude Code, Codex, Cursor…) lea y edite los diagramas de una carpeta: crea diagramas a partir de nodos y flechas, los acomoda solo (layout por capas), linkea diagramas entre sí y maneja los comentarios.

Solo escribe archivos `.excalidraw` y sus sidecars `.comments.json`. No necesita la UI abierta; si la carpeta está en tu vista y la UI está abierta, los cambios aparecen en vivo porque el servidor HTTP la vigila. Cada edición relee el archivo y escribe con hash base, así no pisa lo que estés editando en el navegador (si hay conflicto, relee y reintenta una vez).

```bash
node server/mcp.ts --root /ruta/a/mis-diagramas
```

La raíz sale de `--root`, si no de `SERRUGRAMS_ROOT`, si no del directorio actual. Requiere Node 24 (corre TypeScript nativo, sin build).

Con el paquete npm instalado (o por `npx`), el equivalente es `serrugrams mcp --root /ruta/a/mis-diagramas`, que corre el servidor ya compilado. En la configuración de cualquier cliente: `"command": "npx", "args": ["-y", "serrugrams", "mcp", "--root", "/ABS/diagramas"]`.

## Herramientas

| Tool | Qué hace |
| --- | --- |
| `list_diagrams()` | Todos los diagramas, a qué diagramas linkea cada uno y cuántos comentarios abiertos tiene. |
| `read_diagram(path, raw?)` | Resumen compacto: nodos (id, tipo, label, x, y, w, h, link, customData), flechas (from, to, label, estilo) y textos sueltos. `raw: true` agrega los elementos crudos. |
| `create_diagram(path, nodes, edges, direction?, overwrite?)` | Crea un diagrama. Falla si ya existe, salvo `overwrite: true`. |
| `add_elements(path, nodes, edges, direction?)` | Agrega nodos/flechas; las flechas pueden apuntar a ids existentes. Lo nuevo se ubica sin pisar lo que hay. |
| `update_element(path, id, patch)` | `label`, `x`/`y` (re-rutea las flechas), `width`/`height`, colores, `link`, `customData` (merge), `style` (flechas). |
| `delete_elements(path, ids)` | Borra; un nodo se lleva su label y sus flechas. |
| `link_element(path, id, target_path, target_element_id?, create_target?)` | Hace que un elemento abra otro diagrama. `target_path: null` lo deslinkea. |
| `rename_diagram(from, to)` | Renombra/mueve; mueve los comentarios y actualiza los links entrantes. |
| `list_comments(path, include_resolved?)` | Hilos de comentarios con su elemento ancla. |
| `add_comment(path, text, element_id? \| x,y, author?)` | Nuevo hilo, anclado a un elemento o a un punto. Autor por defecto: `agent`. |
| `reply_comment(path, comment_id, text, author?)` | Responde un hilo. |
| `resolve_comment(path, comment_id, resolved?)` | Resuelve (o reabre con `resolved: false`). |

Nodo: `{ id?, type?: rectangle|ellipse|diamond|text, label?, x?, y?, width?, height?, backgroundColor?, strokeColor?, link?, customData? }`. Sin `x` e `y` se ubica con el layout automático (`direction`: `LR` por defecto, o `TB`).

Flecha: `{ from, to, label?, style?: solid|dashed|dotted, arrowhead?: arrow|none, bidirectional? }`. `from`/`to` son ids (o un label exacto si no se repite).

También expone el prompt `system_design_conventions` y las mismas convenciones van en las `instructions` del servidor.

## Convenciones

- Un diagrama de alto nivel (`overview.excalidraw`) con una caja por sistema, y cada caja linkeada a su diagrama de detalle (`pagos/detalle.excalidraw`).
- Los links se guardan en el campo nativo `link` como `/pagos/detalle.excalidraw` o `/pagos/detalle.excalidraw#elementId`.
- Metadata en `customData`: `{ "service": "...", "repo": "org/repo", "team": "..." }`.
- Labels cortos; las explicaciones van en comentarios.

## Configuración

En todos los casos usá rutas absolutas: `/ABS/serrugrams/server/mcp.ts` es este repo y `/ABS/diagramas` la carpeta con los diagramas.

### Claude Code

Con la CLI:

```bash
claude mcp add serrugrams -- node /ABS/serrugrams/server/mcp.ts --root /ABS/diagramas
# o compartido con el equipo, en el .mcp.json del proyecto:
claude mcp add -s project serrugrams -- node /ABS/serrugrams/server/mcp.ts --root /ABS/diagramas
```

O a mano, en el `.mcp.json` del proyecto:

```json
{
  "mcpServers": {
    "serrugrams": {
      "command": "node",
      "args": ["/ABS/serrugrams/server/mcp.ts", "--root", "/ABS/diagramas"]
    }
  }
}
```

El `.mcp.json` de este repo registra `node server/mcp.ts --root examples` (ruta relativa al directorio desde el que Claude Code lanza el servidor, la raíz del repo): la misma carpeta que usa `npm run dev`.

### Codex

En `~/.codex/config.toml`:

```toml
[mcp_servers.serrugrams]
command = "node"
args = ["/ABS/serrugrams/server/mcp.ts", "--root", "/ABS/diagramas"]
```

### Cursor

En `~/.cursor/mcp.json` (global) o `.cursor/mcp.json` (por proyecto):

```json
{
  "mcpServers": {
    "serrugrams": {
      "command": "node",
      "args": ["/ABS/serrugrams/server/mcp.ts", "--root", "/ABS/diagramas"]
    }
  }
}
```

## Tests

```bash
node --test server/builder.test.ts server/mcp.test.ts
```

`mcp.test.ts` es end-to-end: levanta el servidor con `--root` en una carpeta temporal y lo maneja con el cliente oficial del SDK.
