# Cloud y colaboración en vivo — propuesta

Estado: propuesta para discutir. No hay código.

## Qué se busca

Que varias personas (y agentes) editen el mismo diagrama a la vez y vean los cambios y cursores de los demás, sin instalar nada más que abrir una URL.

## Restricciones que se mantienen

- Se construye sobre `@excalidraw/excalidraw`, sin fork.
- El formato sigue siendo una carpeta de archivos `.excalidraw` más sus `.comments.json`. Nada de base de datos propia para el contenido.
- El modo local no cambia: sigue escuchando solo en `127.0.0.1`, sin cuentas.

## Idea central

El cloud es **el mismo servidor, desplegado**, con tres agregados: salas en vivo, autenticación y, opcional, historial en git.

"El disco es la fuente de verdad" se conserva cambiando de quién es el disco: en un espacio compartido, la fuente de verdad es la carpeta del servidor. Cada navegador deja de escribir el archivo entero y pasa a mandar cambios a una sala; el servidor es el único que escribe a disco.

### Salas en vivo

- Un WebSocket por diagrama abierto. Los clientes mandan los elementos que cambiaron y la posición del cursor; el servidor los reenvía al resto y guarda a disco con un retardo corto.
- Para combinar cambios se usa lo que Excalidraw ya trae: `reconcileElements` (gana la versión más nueva de cada elemento) y la prop `collaborators` para cursores y nombres. Es el mismo mecanismo que usa excalidraw.com, y una versión completa de lo que hoy hace `pullRemote` en `src/Editor.tsx`.
- No hace falta un CRDT (Yjs). Se pierde edición sin conexión con merge fino; se gana no sumar una dependencia grande ni otro formato intermedio. Se puede revisar si aparece la necesidad.
- Los comentarios viajan por la misma sala. De paso se resuelve el pendiente de concurrencia: el servidor los serializa.

### Agentes

- El MCP escribe a través de la sala (no directo al archivo) cuando el diagrama está abierto, así sus cambios entran al mismo merge.
- Para usarlo remoto: MCP por HTTP en el mismo servidor, con un token por espacio. El MCP por stdio sigue sirviendo para carpetas locales.

### Historial

Opcional: la carpeta del servidor es un repo git y se commitea cada tanto o al cerrarse una sala. Da historial, y permite clonar el espacio y abrirlo en modo local.

## Decisiones que necesito de vos

1. **Acceso.** (a) Link con token por espacio: lo más simple, sin identidad real. (b) Login con GitHub: nombres en cursores y comentarios, permisos por persona. Recomiendo empezar con (a) y que el nombre se escriba a mano.
2. **Hosting.** Hace falta un proceso Node persistente con disco y WebSockets (Fly.io, Railway, un VPS). No sirve serverless tipo Vercel. ¿Tenés preferencia o infraestructura ya paga?
3. **Git en el servidor.** ¿Lo querés desde el principio o después?
4. **Red local.** ¿Querés un paso intermedio que abra el servidor a la red local con un flag explícito, o se pasa directo de localhost al despliegue con acceso? Abrirlo cambia la decisión de escuchar solo en `127.0.0.1`.
5. **Privacidad.** excalidraw.com cifra de punta a punta; acá no se puede si el servidor guarda los archivos y los agentes los leen. ¿Es aceptable que el servidor vea el contenido?

## Etapas

1. **Salas en el servidor local.** WebSocket, relay, merge y cursores, todavía solo en `127.0.0.1`: dos pestañas alcanzan para probar la colaboración de verdad sin cuentas ni hosting, y todo lo que sigue se apoya en esto.
2. **Acceso y despliegue.** Tokens o login, HTTPS detrás de un proxy, límites de tamaño.
3. **MCP remoto e historial en git.**

## Riesgos

- **Seguridad.** Hoy la defensa es "solo localhost". Fuera de localhost, cada endpoint necesita autenticación y hay que revisar de nuevo los chequeos de `Host`/`Origin`.
- **Imágenes.** Los archivos embebidos viajan en el `.excalidraw`; en vivo conviene subirlos aparte y no reenviarlos en cada cambio.
- **Dos escritores.** Si alguien edita la carpeta del servidor por fuera (git pull, un agente por stdio) mientras hay una sala abierta, hay que resolverlo como hoy: releer y combinar por versión.
