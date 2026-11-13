# MCP de Serrugrams

Servidor MCP (stdio) para que un agente (Claude Code, Codex, Cursor…) lea y edite los diagramas de una carpeta: crea diagramas a partir de nodos y flechas, los acomoda solo (layout por capas), linkea diagramas entre sí y maneja los comentarios.

Solo escribe archivos `.excalidraw` y sus sidecars `.comments.json`. No necesita la UI abierta; si la carpeta está en tu vista y la UI está abierta, los cambios aparecen en vivo porque el servidor HTTP la vigila. Cada edición relee el archivo y escribe con hash base, así no pisa lo que estés editando en el navegador (si hay conflicto, relee y reintenta una vez).

```bash
node server/mcp.ts --root /ruta/a/mis-diagramas
```

La raíz sale de `--root`, si no de `SERRUGRAMS_ROOT`, si no del directorio actual. Requiere Node 24 (corre TypeScript nativo, sin build).

- **Una raíz relativa se resuelve desde la raíz del repo**: la carpeta más cercana hacia arriba que tiene `.git` (o el directorio actual, si no hay repo). Con `--root docs/diagramas`, el servidor apunta al `docs/diagramas` del repo en el que está, se lance desde donde se lance.
- **La carpeta raíz no se crea al arrancar.** Aparece al escribir el primer diagrama, así que tener el MCP configurado no deja carpetas vacías en los repos que no diagramaste.

Con el paquete npm instalado (o por `npx`), el equivalente es `serrugrams mcp --root /ruta/a/mis-diagramas`, que corre el servidor ya compilado. En la configuración de cualquier cliente: `"command": "npx", "args": ["-y", "serrugrams", "mcp", "--root", "/ABS/diagramas"]`.

## Herramientas

| Tool | Qué hace |
| --- | --- |
| `list_diagrams()` | La raíz, todos los diagramas, a qué diagramas linkea cada uno y cuántos comentarios abiertos tiene. También `addToView`: el comando que suma esa carpeta a tu vista. |
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

Expone dos prompts: `system_design_conventions` (las convenciones, que también van en las `instructions` del servidor) y `diagramar`, el flujo completo de la skill.

## Skill

`skills/serrugrams/SKILL.md` le enseña al agente el trabajo entero: ubicarse en el repo, entender el código antes de dibujar, diagramar del panorama al detalle, dejar las dudas como comentarios y, en el otro sentido, atender los comentarios de un diagrama.

- **Claude Code:** se instala con un symlink y se activa sola ante pedidos como «diagramá cómo funciona X» o «revisá los comentarios del diagrama».

  ```bash
  ln -s /ABS/serrugrams/skills/serrugrams ~/.claude/skills/serrugrams
  ```

- **Otros clientes:** el MCP sirve ese mismo archivo como el prompt `diagramar`, con un argumento opcional `pedido`. En Claude Code también aparece, como `/mcp__serrugrams__diagramar`.

Al cerrar, el agente pregunta si suma los diagramas a tu vista y, si decís que sí, corre el comando de `addToView` (`serrugrams <carpeta>`).

## Convenciones

- Un diagrama de alto nivel (`panorama.excalidraw`) con una caja por sistema, y cada caja linkeada a su diagrama de detalle (`pagos/detalle.excalidraw`).
- Los links se guardan en el campo nativo `link` como `/pagos/detalle.excalidraw` o `/pagos/detalle.excalidraw#elementId`.
- Metadata en `customData`: `{ "repo": "org/repo", "service": "...", "file": "src/server.ts" }` (y, si sirven, `team` u `owner`).
- Labels cortos; las explicaciones van en comentarios.

## Configuración

`/ABS/serrugrams/server/mcp.ts` es este repo, siempre con ruta absoluta. La raíz puede ser absoluta (`/ABS/diagramas`) o relativa al repo en el que trabaja el agente (`docs/diagramas`).

### Claude Code

Lo recomendado es configurarlo **una sola vez, a nivel usuario**, con la raíz relativa. En cada repo apunta a su `docs/diagramas`:

```bash
claude mcp add -s user serrugrams -- node /ABS/serrugrams/server/mcp.ts --root docs/diagramas
```

Para un repo que guarda los diagramas en otra carpeta, o para compartir la configuración con el equipo, va en el `.mcp.json` del proyecto, que le gana a la del usuario:

```bash
claude mcp add -s project serrugrams -- node /ABS/serrugrams/server/mcp.ts --root /ABS/diagramas
```

O a mano:

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

Este repo no trae `.mcp.json`: usa la configuración del usuario, como cualquier otro, y sus diagramas van a `docs/diagramas`. Para probar contra los ejemplos de `pnpm dev`: `node server/mcp.ts --root examples`.

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

`mcp.test.ts` es end-to-end: levanta el servidor con `--root` en una carpeta temporal y lo maneja con el cliente oficial del SDK. También cubre la raíz relativa (resuelta desde la raíz del repo y sin crear hasta el primer diagrama) y el prompt `diagramar`.
