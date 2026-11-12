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

## Estado y pendientes conocidos

- Probado en el navegador: crear, dibujar, autoguardado, links y navegación, renombrar con reescritura de links, comentarios, exportar e importar con comentarios, y ediciones por MCP con el diagrama abierto.
- El MCP se probó con el cliente oficial del SDK y desde Claude Code real (las 12 herramientas, con el `.mcp.json` del repo y la app abierta); todavía no desde Codex o Cursor.
- Las fuentes de Excalidraw se copian solas a `public/fonts` en `pnpm install` (`scripts/copy-fonts.mjs`; a mano: `pnpm fonts`).
- `prefers-reduced-motion` está revisado por código (CSS y el desplazamiento al llegar por link), no con el ajuste del sistema activado.
- La URL guarda el diagrama pero no el elemento: `#elementId` solo se enfoca al llegar por un link, no al pegar la URL.
- Los comentarios no tienen control de concurrencia: si dos procesos los editan a la vez, gana el último.
- `bin/serrugrams.js` funciona desde el repo clonado; para publicarlo como paquete npm hay que compilar el servidor a JavaScript.
- Colaboración en la nube y edición en vivo entre personas: no implementado.
