---
name: serrugrams
description: Investiga el código de un repo y lo diagrama con el MCP de Serrugrams (archivos .excalidraw en docs/diagramas, del panorama al detalle), o atiende los comentarios que dejaron en un diagrama. Usar cuando piden dibujar o actualizar un diagrama de un sistema — «diagramá cómo funciona X», «hacé un diagrama de…», «actualizá el panorama» — o «revisá los comentarios del diagrama». No usar ante una mención suelta de diagramas: preguntas sobre un diagrama, Mermaid o ASCII dentro de un documento, o cambios al código de Serrugrams.
---

# Diagramar un sistema con Serrugrams

Serrugrams guarda cada diagrama como un archivo `.excalidraw` en el repo que describe, en `docs/diagramas/`, versionado con el código. Los comentarios van aparte, en `<diagrama>.excalidraw.comments.json`. Todo se lee y se escribe con las herramientas del MCP `serrugrams` (`list_diagrams`, `read_diagram`, `create_diagram`, `add_elements`, `update_element`, `delete_elements`, `link_element`, `rename_diagram`, `list_comments`, `add_comment`, `reply_comment`, `resolve_comment`).

Si esas herramientas no están en la sesión, decilo y frená. No escribas el JSON de Excalidraw a mano: el layout y las flechas los arma el MCP. La configuración está en `docs/mcp.md` del repo de Serrugrams.

Hay dos pedidos posibles: diagramar algo (pasos 1 a 5) o revisar comentarios (paso 6).

## 1. Ubicarse

1. Identificá el repo: su raíz (`git rev-parse --show-toplevel`) y su nombre (`org/repo` del remoto; si no hay remoto, el nombre de la carpeta).
2. Llamá a `list_diagrams`. Devuelve la raíz de los diagramas. Tiene que ser `<raíz del repo>/docs/diagramas`, o la carpeta que ese repo ya use para sus diagramas. Si apunta a otro repo, frená y avisá: el MCP se lanzó desde otro lado y escribiría en el lugar equivocado.
3. Si ya hay diagramas, leé con `read_diagram` el panorama y los detalles que toquen el pedido. Lo que existe se actualiza, no se duplica:
   - Usá `add_elements`, `update_element` y `delete_elements`. No uses `overwrite: true` sobre un diagrama existente: se pierden las posiciones que la persona acomodó a mano.
   - No muevas cajas que no hace falta mover.
   - Reusá los ids y los nombres que ya están.

La carpeta `docs/diagramas` no hace falta crearla: aparece con el primer diagrama.

## 2. Entender antes de dibujar

No dibujes nada hasta poder contestar, con archivos concretos:

- **Puntos de entrada:** servidores HTTP, CLIs, workers, crons, handlers de eventos, la interfaz.
- **Servicios o módulos:** las piezas con una responsabilidad propia y quién llama a quién.
- **Datos:** bases, tablas o colecciones principales, caches, archivos en disco.
- **Colas y eventos:** qué se publica, quién lo consume.
- **Integraciones externas:** APIs de terceros, autenticación, pagos, correo, almacenamiento.

Empezá por lo que ya lo cuenta (README, `docs/`, manifiestos, docker-compose, configuración de despliegue) y después confirmalo en el código. Lo que diga la documentación y el código no respalde no entra como hecho.

En un repo grande, repartí la investigación en subagentes en paralelo, uno por área (por ejemplo un servicio o un paquete cada uno). A cada uno pedile lo mismo: componentes, relaciones con su protocolo, datos que toca, y para cada afirmación el archivo y la línea que la respalda, más una lista de lo que no pudo confirmar. Los subagentes investigan; el diagrama lo armás vos, con todo junto.

Si el pedido es acotado («diagramá cómo funciona el login»), investigá ese flujo y lo que toca, no el repo entero. Del resto alcanza con lo necesario para ubicarlo en el panorama.

## 3. Diagramar de lo general al detalle

### Panorama

`panorama.excalidraw` tiene una caja por sistema. Es el mapa para ubicarse, no el lugar de los detalles.

- **Entra:** cada pieza que se despliega o corre por separado, cada base o cola, cada integración externa y los actores que usan el sistema.
- **No entra:** clases, funciones, endpoints sueltos, librerías, tablas individuales.
- Entre 5 y 12 cajas. Si pasás de 12, agrupá en subsistemas y bajá el resto a los detalles.
- Si el panorama ya existe y el pedido es sobre un sistema, sumá o corregí solo lo que cambió.
- Siempre hay panorama. Si el pedido es acotado («diagramá cómo funciona el login») y todavía no existe, crealo igual, chico, con ese sistema y los vecinos con los que habla, y linkeá su caja al diagrama que te pidieron. Sin panorama, el diagrama queda suelto y nadie llega a él.

### Detalle

Un detalle por sistema, en una subcarpeta: `<sistema>/detalle.excalidraw` (por ejemplo `pagos/detalle.excalidraw`). Si un sistema tiene varios flujos que no entran en uno, sumá `<sistema>/<flujo>.excalidraw`.

- **Hace falta** cuando el sistema tiene cuatro o más piezas internas que importan, o un flujo que no se entiende desde el panorama, o cuando es justo lo que pidieron.
- **No hace falta** para una base, una cola o un servicio externo, ni para un sistema que es una sola pieza: la caja del panorama alcanza.
- Entre 6 y 15 cajas. Las bases y los sistemas vecinos aparecen en el detalle como cajas de borde, para que se vea con qué habla.

### Cómo armarlos

1. Creá primero los detalles y después el panorama (o actualizalo).
2. Linkeá cada caja del panorama a su detalle con `link_element`, que valida que el destino exista. Una caja sin detalle queda sin link.
3. Convenciones del MCP: rectángulo para servicio o componente, elipse para datos o actor externo, rombo para decisión. Flecha sólida para llamada sincrónica, punteada (`dashed`) para eventos y colas, de puntos (`dotted`) para dependencias opcionales. La etiqueta de la flecha es el protocolo o el verbo: «HTTPS», «publica PedidoPagado».
4. Ids legibles (`api`, `pedidos-db`) y labels de una a cuatro palabras. La tecnología puede ir en una segunda línea: `Pedidos\n(Go)`.
5. Dejá que el layout automático ubique las cajas; `direction: "TB"` cuando el flujo se lee mejor de arriba hacia abajo.
6. En `customData` de cada caja:
   - `repo`: `org/repo`.
   - `service`: el nombre del sistema o servicio.
   - `file`: la ruta, desde la raíz del repo, del archivo donde empieza (el punto de entrada en el panorama; el archivo de esa pieza en el detalle).

   En una caja externa, solo `service`.

### Qué va en comentarios y no en las cajas

Las cajas dicen qué es cada cosa. Lo demás va en un comentario anclado a la caja (`add_comment` con `element_id`):

- El porqué de una decisión, una restricción o un límite conocido.
- Reglas de negocio, reintentos, timeouts, permisos.
- Lo que no quedó claro (paso 4).

No comentes lo obvio. Un diagrama con dos o tres comentarios que importan se lee; uno con veinte, no.

## 4. Lo que no queda claro no se inventa

Si el código no alcanza para afirmar algo (quién consume un evento, si una integración sigue en uso, a qué base apunta un servicio en producción), no lo dibujes como si fuera cierto. Dibujá lo que sí se sabe y dejá un comentario anclado a la caja, que empiece con «Duda:», diga qué falta confirmar y dónde miraste. Por ejemplo: «Duda: no encontré quién consume `pedido.pagado`. Se publica en `src/pagos/eventos.ts:41`.»

Una relación dudosa se dibuja con flecha de puntos (`dotted`) y su comentario, o no se dibuja.

## 5. Cerrar

Contá, en pocas líneas:

- Qué diagramas creaste o actualizaste, con sus rutas.
- Cuántas dudas quedaron como comentarios y sobre qué.
- Que los archivos quedaron sin commitear (no commitees salvo que te lo pidan).

Después preguntá: «¿Lo sumo a tu vista?». Si dicen que sí, corré el comando que devuelven `list_diagrams` y `create_diagram` en `addToView`. Levanta el servidor si no está corriendo, suma la carpeta a la vista y abre http://localhost:4747. No lo corras sin el sí: la vista es personal.

## 6. Revisar los comentarios de un diagrama

Cuando piden «revisá los comentarios del diagrama»:

1. Si no dijeron cuál, `list_diagrams` muestra cuántos comentarios abiertos tiene cada uno.
2. `list_comments` con `include_resolved: false`, y `read_diagram` del mismo diagrama.
3. Para cada hilo abierto, entendé qué pide y verificalo en el código antes de tocar nada.
   - **Pide un cambio y el código lo respalda:** corregí el diagrama, respondé con `reply_comment` qué cambiaste y en qué archivo te basaste, y cerralo con `resolve_comment`.
   - **Es una pregunta:** respondela con el archivo que lo muestra. Resolvela solo si la respuesta la cierra.
   - **El código dice otra cosa, o no alcanza para decidir:** respondé con lo que encontraste y dejá el hilo abierto. No resuelvas un hilo sin haber hecho lo que pedía.
4. Si un cambio afecta a otro diagrama (una caja renombrada en el panorama, un link), actualizalo también. Para mover o renombrar un diagrama usá `rename_diagram`, que reescribe los links.
5. Al terminar, decí qué hilos resolviste, cuáles quedaron abiertos y por qué.
