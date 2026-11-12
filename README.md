# Serrugrams

Diagramas de sistemas sobre [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT), pensados para ir del panorama general al detalle y para trabajar junto con agentes.

- **Explorador de carpeta.** Cada diagrama es un archivo `.excalidraw` en disco. Se versiona con git y abre también en excalidraw.com.
- **Links entre diagramas.** Cualquier elemento puede llevar a otro diagrama. Hay historial para volver atrás y se recuerda dónde estabas en cada uno.
- **Comentarios.** Se anclan a un elemento o a un punto del lienzo y se guardan aparte, en `<diagrama>.excalidraw.comments.json`. Al exportar elegís si van o no.
- **MCP para agentes.** Claude Code, Codex, Cursor o cualquier cliente MCP puede listar, leer, crear y editar diagramas. Si la app está abierta, los cambios aparecen en vivo. Ver [docs/mcp.md](docs/mcp.md).

## Uso

Requiere Node 24 o superior y pnpm.

```bash
pnpm install
pnpm build
node server/index.ts /ruta/a/una/carpeta   # abre http://localhost:4747
```

Sin carpeta, usa el directorio actual. `--port` cambia el puerto.

Para desarrollo (recarga en caliente, usa la carpeta `examples/`):

```bash
pnpm dev   # UI en http://localhost:5173
```

## Atajos

| Atajo | Acción |
|---|---|
| `⌘P` | Buscar y abrir un diagrama |
| `⌥←` / `⌥→` (o `⌘[` / `⌘]`) | Volver / adelante |
| `⌘\` | Mostrar u ocultar el explorador |
| `F2` | Renombrar el archivo enfocado en el explorador |

## Cómo se guardan las cosas

- **Diagramas:** JSON estándar de Excalidraw. El disco es la fuente de verdad: la app observa la carpeta y recarga si otro proceso (un agente, git) cambia un archivo.
- **Links:** en el campo nativo `link` del elemento, como ruta desde la raíz de la carpeta: `/pagos/detalle.excalidraw` o `/pagos/detalle.excalidraw#<idElemento>`. Al renombrar o mover un diagrama desde la app o el MCP, los links que apuntaban a él se actualizan.
- **Comentarios:** archivo sidecar junto al diagrama. Si el elemento anclado se borra, el comentario queda en su última posición.
- **Papelera:** eliminar mueve a `.serrugrams/trash/` dentro de la carpeta; no borra.

## Seguridad

El servidor escucha solo en `127.0.0.1`, rechaza pedidos con `Host` u `Origin` que no sean locales y no lee ni escribe fuera de la carpeta abierta.

## Estructura

- `server/` — servidor HTTP (`index.ts`), acceso a disco (`workspace.ts`), MCP (`mcp.ts`, `builder.ts`, `layout.ts`).
- `src/` — interfaz en React.
- `shared/types.ts` — formatos compartidos.
- `.claude/skills/` — skills de diseño de Emil Kowalski (MIT), usadas como guía para la interfaz.
