# Serrugrams

Diagramas de sistemas sobre [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT), pensados para ir del panorama general al detalle y para trabajar junto con agentes.

- **Tu vista, de varios repos.** Cada diagrama es un archivo `.excalidraw` en su repo, versionado con git, que abre también en excalidraw.com. Un solo servidor muestra las carpetas y diagramas que elegiste.
- **Links entre diagramas.** Cualquier elemento puede llevar a otro diagrama. Hay historial para volver atrás y se recuerda dónde estabas en cada uno.
- **Comentarios.** Se anclan a un elemento o a un punto del lienzo y se guardan aparte, en `<diagrama>.excalidraw.comments.json`. Al exportar elegís si van o no.
- **MCP para agentes.** Claude Code, Codex, Cursor o cualquier cliente MCP puede listar, leer, crear y editar diagramas. Si la app está abierta, los cambios aparecen en vivo. Ver [docs/mcp.md](docs/mcp.md).

## Uso

Requiere Node 24 o superior.

Serrugrams se levanta **una sola vez** y muestra tu **vista**: las carpetas y diagramas sueltos que elegiste, de cualquier repo. Los archivos se quedan en cada repo, versionados con su código; la vista es personal y vive en `~/.serrugrams/workspace.json`. Se arma desde la interfaz, con el botón «Agregar a la vista» de la barra lateral. Detalle del diseño en [docs/referencias.md](docs/referencias.md).

Desde el repo clonado (con pnpm), con un alias para tenerlo a mano:

```bash
pnpm install
pnpm build   # también después de cada git pull: la interfaz sale de dist/
alias serrugrams="node /ruta/al/clon/bin/serrugrams.js"   # en ~/.zshrc
```

Una vez publicado en npm, `npx serrugrams` hace lo mismo sin clonar nada.

### Comandos

| Comando | Qué hace |
|---|---|
| `serrugrams` | Levanta el servidor de fondo (si no está corriendo) y abre http://localhost:4747. |
| `serrugrams <ruta>…` | Lo mismo, y suma esas carpetas o diagramas a la vista. |
| `serrugrams ls` | Estado del servidor y lo que hay en la vista (funciona también con el servidor apagado). |
| `serrugrams remove <nombre\|ruta>` | Quita algo de la vista. No borra nada del disco. |
| `serrugrams open` | Abre el navegador. |
| `serrugrams stop` | Apaga el servidor. |
| `serrugrams logs [-f]` | Lo que imprimió el servidor; `-f` lo sigue en vivo. |
| `serrugrams mcp --root <carpeta>` | Servidor MCP por stdio, para agentes. |
| `serrugrams help` | La ayuda. |

Opciones: `--port N` cambia el puerto, `--fg` lo deja en la terminal (se apaga con `Ctrl+C`) y `--no-open` no abre el navegador. El estado y el log del servidor van a `~/.serrugrams/` (`SERRUGRAMS_HOME` cambia esa carpeta).

Apagarlo no pierde nada: el disco es la fuente de verdad. El servidor web es independiente del MCP; Claude puede leer y editar los diagramas de un repo sin que esté prendido, y después vos decidís si los sumás a la vista.

Para desarrollo (recarga en caliente):

```bash
pnpm dev   # UI en http://localhost:5173, API en el 4848 y una vista aparte con examples/
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
- **Vista:** `~/.serrugrams/workspace.json`, con la ruta absoluta de cada carpeta o diagrama. Si una ruta deja de existir, aparece tachada y se puede quitar.
- **Links:** en el campo nativo `link` del elemento, como ruta desde la raíz de los diagramas del repo: `/pagos/detalle.excalidraw` o `/pagos/detalle.excalidraw#<idElemento>`. Se resuelven buscando desde la raíz de la referencia hacia la carpeta del diagrama, así funcionan igual si sumás `docs/diagramas`, la raíz del repo o un diagrama suelto. Al renombrar o mover un diagrama desde la app o el MCP, los links que apuntaban a él se actualizan.
- **Comentarios:** archivo sidecar junto al diagrama. Si el elemento anclado se borra, el comentario queda en su última posición.
- **Papelera:** eliminar mueve a `.serrugrams/trash/` dentro de la carpeta de la referencia; no borra. Quitar algo de la vista no toca el disco.

## Seguridad

El servidor escucha solo en `127.0.0.1`, rechaza pedidos con `Host` u `Origin` que no sean locales y no lee ni escribe fuera de las carpetas de la vista (para un diagrama suelto, la raíz de su repo). El autocompletado de «Agregar a la vista» lista nombres de carpetas y diagramas de tu disco, nunca su contenido.

## Estructura

- `server/` — servidor HTTP (`index.ts`), la vista y sus referencias (`refs.ts`), acceso a disco (`workspace.ts`), MCP (`mcp.ts`, `builder.ts`, `layout.ts`).
- `src/` — interfaz en React.
- `shared/types.ts` — formatos compartidos.
- `dist/` — salida de `pnpm build` (no se versiona): `dist/ui` es la interfaz y `dist/server` + `dist/shared` el servidor compilado a JavaScript. Es lo que viaja en el paquete npm junto con `bin/`.
- `.claude/skills/` — skills de diseño de Emil Kowalski (MIT), usadas como guía para la interfaz.

## Estado y pendientes conocidos

- Vista con referencias (un servidor, carpetas y diagramas sueltos de varios repos): probado en el navegador agregando, quitando, renombrando, siguiendo links a diagramas fuera de la vista, creando un diagrama al lado de uno suelto y con una carpeta que desaparece y vuelve; tests en `server/refs.test.ts` y `server/cli.test.ts`. Los links entre repos distintos no están soportados.
- Probado en el navegador: crear, dibujar, autoguardado, links y navegación, renombrar con reescritura de links, comentarios, exportar e importar con comentarios, y ediciones por MCP con el diagrama abierto.
- El MCP se probó con el cliente oficial del SDK y desde Claude Code real (las 12 herramientas, con el `.mcp.json` del repo y la app abierta); todavía no desde Codex o Cursor.
- Las fuentes de Excalidraw se copian solas a `public/fonts` al empezar `pnpm dev` y `pnpm build` (`scripts/copy-fonts.mjs`; a mano: `pnpm fonts`).
- El encuadre inicial calcula el zoom exacto (85 % del lienzo, sin pasar del 100 % ni dejar contenido debajo de las barras de arriba y abajo) en vez de usar el de Excalidraw, que redondea hacia abajo de a 10 %.
- Al llegar por un link con `#elementId`, el destino se marca con un contorno que se desvanece; no se selecciona, así no se abre el panel de propiedades.
- Un link a un elemento del mismo diagrama no suma una entrada al historial: "atrás" vuelve al diagrama anterior, no a la vista previa.
- `prefers-reduced-motion` probado con "Reducir movimiento" activado en macOS: al llegar por link el lienzo salta sin animar y el contorno aparece y se va de golpe, sin desvanecerse. Sin el ajuste, el desplazamiento dura unos 300 ms y el contorno lo sigue. Los popovers, diálogos, avisos y tooltips solo están revisados por código.
- La URL guarda el diagrama pero no el elemento: `#elementId` solo se enfoca al llegar por un link, no al pegar la URL.
- Los comentarios no tienen control de concurrencia: si dos procesos los editan a la vez, gana el último.
- Paquete npm: `pnpm build` compila el servidor a `dist/server` y `bin/serrugrams.js` lo usa cuando no está el fuente (en el repo clonado sigue corriendo el TypeScript). Probado instalando el tarball de `npm pack` en una carpeta aparte (UI con fuentes y MCP con las 12 herramientas). Falta publicarlo (`npm publish`), confirmar que el nombre `serrugrams` esté libre y definir la licencia. El paquete pesa unos 15 MB por el bundle y las fuentes de Excalidraw.
- Colaboración en la nube y edición en vivo entre personas: no implementado. Propuesta de diseño en [docs/cloud.md](docs/cloud.md).
