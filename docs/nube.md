# Serrugrams en la nube

La app completa —crear, editar, renombrar, mover, comentar, importar y exportar— en una URL, con los diagramas guardados en **Vercel Blob** y una contraseña. Pensada para una persona en varias computadoras: abrís la URL en cualquiera y seguís donde dejaste.

No reemplaza el modo local: tus repos, la vista con varias carpetas y el MCP siguen igual. La nube es otra carpeta, que vive en Vercel en vez de en tu disco.

## Cómo está armado

```
navegador ── UI (la misma, en modo nube) ──► /api/* ── función de Vercel ──► Vercel Blob (privado)
                                               server/vercel.ts               prefijo diagramas/
                                               └ server/cloud.ts (API + contraseña)
                                                 └ Workspace (server/workspace.ts) sobre BlobStore
```

- **Mismo Workspace, otro disco.** `Workspace` ya no toca el disco directamente: usa un `Store` (`server/store.ts`). En local es `DiskStore`, como siempre. En la nube es `BlobStore` (`server/blobstore.ts`), un depósito de claves planas: las carpetas salen de las rutas, y una carpeta vacía es una clave `<carpeta>/.keep`. Las reglas (árbol, links que se actualizan al renombrar, papelera, conflictos) son las mismas, y `server/workspace.test.ts` las corre contra los dos.
- **La API** (`server/cloud.ts`) es la de local con una sola referencia, `nube`. No trae lo que solo sirve en tu máquina: armar la vista con carpetas del disco, el selector de carpetas, ubicar lo soltado desde Finder ni los eventos en vivo.
- **La UI** se entera de que está en la nube por `<meta name="serrugrams-cloud">` (las banderas de cada modo están en `src/mode.ts`). Pide la contraseña antes de mostrar nada (`src/Login.tsx`); si la sesión vence a mitad de camino, la pide encima de lo abierto, sin perderlo.
- **Sin eventos en vivo.** Al volver a la pestaña relee el árbol, el diagrama abierto y sus comentarios. Si guardaste lo mismo en dos compus a la vez, se detecta el conflicto y se combinan las dos versiones elemento por elemento, como en local.
- **Lecturas sin caché** (`useCache: false`): una lectura vieja justo después de guardar haría que el editor vea un conflicto que no existe.

## MCP en la nube

La misma función sirve el MCP por HTTP en `https://serrugrams.vercel.app/api/mcp`, con las mismas 12 herramientas que el local (`server/mcpserver.ts` las comparten), sobre el mismo Blob. Un agente en cualquier compu crea y edita los diagramas de la nube, y vos los ves en la app al volver a la pestaña.

- **Token propio**, no la contraseña: `Authorization: Bearer <token>`, guardado en la variable secreta `SERRUGRAMS_MCP_TOKEN` del proyecto. Sin esa variable, `/api/mcp` responde 503; sin token o con otro, 401. La cookie de la app no sirve para el MCP.
- En esta compu el token está en `serrugrams-cloud/.mcp-token` (ignorado por git). Para la otra compu, copialo de ahí.
- **Sin sesiones**: cada pedido arma su servidor y responde JSON. No hay notificaciones en vivo, que el MCP no usa.
- Las rutas son las del store, sin el `nube/` que ve la app: `panorama.excalidraw`, `pagos/detalle.excalidraw`.
- Trae el prompt `diagramar` (la skill, embebida al empaquetar) y, en vez de `addToView`, un link `open` por diagrama para abrirlo en la app.

En Claude Code, una vez por compu (`-s user`: sirve en todos los repos, al lado del MCP local `serrugrams`):

```bash
claude mcp add --transport http -s user serrugrams-nube https://serrugrams.vercel.app/api/mcp --header "Authorization: Bearer $(cat /ruta/a/serrugrams-cloud/.mcp-token)"
```

Para cambiar el token: generá otro, actualizá `SERRUGRAMS_MCP_TOKEN` en Vercel, redeployá y volvé a correr el `claude mcp add` en cada compu.

## Seguridad

- **Contraseña** en la variable `SERRUGRAMS_PASSWORD` del proyecto (secreta, no está en el código ni en el paquete). Sin esa variable, la API responde 503 a todo: cerrada antes que abierta por error.
- **Todo pide sesión**, también las lecturas, salvo `POST /api/login`. La sesión es una cookie `HttpOnly`, `Secure`, `SameSite=Lax`, de 30 días, derivada de la contraseña: cambiarla cierra todas las sesiones.
- **Escrituras** solo con JSON y, si el navegador manda `Origin`, del mismo host.
- **Rutas**: sin `..`, sin rutas absolutas, sin barras invertidas ni carpetas ignoradas (la papelera incluida). Todo vive bajo el prefijo `diagramas/` del store.
- El Blob es **privado**: sus archivos no tienen URL pública; solo la función los lee, con el token que Vercel puso al conectarlo.

Verificado en el deploy: sin cookie, los 10 endpoints dan 401; con la contraseña equivocada, 401. En la nube local: si la sesión vence mientras dibujás, aparece la contraseña encima, y al volver a entrar lo pendiente se guarda solo.

## Lo que hay hoy en Vercel

| | |
| --- | --- |
| Proyecto | `serrugrams`, en el equipo «guillotambo's projects» |
| URL | https://serrugrams.vercel.app |
| Blob | `serrugrams-diagramas`, privado, región `iad1`, conectado al proyecto (variable `BLOB_READ_WRITE_TOKEN`) |
| Contraseña | variable `SERRUGRAMS_PASSWORD` (Production y Preview) |
| MCP | `/api/mcp`, token en la variable `SERRUGRAMS_MCP_TOKEN` (Production y Preview) |

## Actualizar la app

Desde el repo clonado:

```bash
pnpm build                        # la UI
serrugrams cloud build            # → serrugrams-cloud/.vercel/output (UI + una función con toda la API)
cd serrugrams-cloud && vercel deploy --prebuilt --prod
```

`serrugrams-cloud/` queda vinculada al proyecto (`.vercel/project.json`) y se rehace en cada `cloud build`. `vercel deploy --prebuilt` sube lo armado tal cual: Vercel no instala ni compila nada. La función es un solo archivo empaquetado con Vite, así que no necesita `node_modules`.

Para cambiar la contraseña: `vercel env rm SERRUGRAMS_PASSWORD` y `vercel env add SERRUGRAMS_PASSWORD production` (y `preview`), y redeployar.

## Probar sin Vercel

```bash
serrugrams cloud local --root una/carpeta --password algo [--mcp-token otro]   # http://localhost:4950
```

La misma UI y la misma API, sobre una carpeta del disco en vez de Blob. En `.claude/launch.json` está como `serrugrams-cloud-local`, sobre `.serrugrams/nube-local`.

## Límites y pendientes

- **Tamaño.** Cada guardado manda el diagrama entero, y la función de Vercel tiene un tope por pedido: probado en el deploy, 4 MB entran y 5 MB devuelven 413. Un diagrama con imágenes pesadas puede no entrar: la UI avisa («demasiado grande para la nube») en vez de reintentar.
- **Cuota de Blob sin revisar.** No confirmé cuánto incluye el plan Hobby. Cada autoguardado hace una lectura, una escritura y un borrado (la marca de carpeta vacía); cada vez que volvés a la pestaña se lista el store y se lee el archivo de comentarios de cada diagrama. Mirá el uso en el panel de Vercel → Storage las primeras semanas.
- **Sin historial.** Cada guardado reemplaza al anterior. Lo borrado va a la papelera (`diagramas/.serrugrams/trash/` en el Blob), pero no hay versiones anteriores de un diagrama. Si hace falta, se cambia `BlobStore` por un store con versiones sin tocar lo demás.
- **Subir carpetas enteras** todavía no: se importan archivos `.excalidraw` arrastrándolos al explorador (a una carpeta, o a cualquier lado para la raíz). Descargar es «Exportar» de cada diagrama.
- **Dos MCP, dos lugares.** `serrugrams` (local) escribe en el `docs/diagramas` de cada repo; `serrugrams-nube` escribe en la nube. No se sincronizan entre sí: copiar de un lado al otro es exportar e importar, o pedirle al agente que lea de uno y escriba en el otro.
- **La skill elige el lugar.** «Diagramá cómo funciona X» deja los diagramas en el repo, como siempre; «…en la nube» los deja en la nube con `serrugrams-nube`, en una carpeta por repo (`<repo>/panorama.excalidraw`), y al cerrar te pasa el link. Si en la sesión solo está uno de los dos MCP, usa ese.
- **Comentarios sin control de concurrencia**, como en local: si los editás en dos compus a la vez, gana el último guardado. Al volver a la pestaña se releen, así que el caso real (una compu por vez) está cubierto.
- Cada guardado hace unas pocas operaciones en Blob (escribir y, si la carpeta tenía la marca de vacía, borrarla); el árbol lista y lee todos los diagramas. Para decenas de diagramas sobra; para miles, habría que cachear.
