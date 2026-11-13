# Vista con referencias

Serrugrams se levanta **una sola vez** y muestra una lista de referencias que elegís vos: carpetas enteras o diagramas sueltos, de cualquier repo. Los diagramas viven en cada repo, versionados con el código; la vista es personal y vive en tu máquina.

## Qué cambia

- **Un solo servidor**, en el puerto 4747. No hay un servidor por carpeta.
- **La barra lateral muestra tus referencias**, en el orden en que las agregaste, y no todo lo que hay en una carpeta.
- **Se agregan y se quitan desde la interfaz.** Quitar una referencia no borra nada del disco.
- **El MCP no cambia.** Cada repo configura el suyo con `--root` y Claude escribe ahí. Que aparezca en tu vista es decisión tuya.

## El archivo de referencias

`~/.serrugrams/workspace.json` (`SERRUGRAMS_HOME` cambia la carpeta; `--workspace` cambia el archivo):

```json
{
  "version": 1,
  "refs": [
    { "id": "pagos", "path": "/Users/vos/repos/pagos/docs/diagramas" },
    { "id": "checkout", "path": "/Users/vos/repos/checkout/docs/diagramas/panorama.excalidraw" }
  ]
}
```

- `path` es absoluta. Si la movés o la borrás, la referencia queda como «no encontrada» en la barra lateral y no abre nada; se puede quitar.
- `id` es el nombre que ves en la barra lateral y el primer tramo de las URLs. Sale del nombre del repo (`…/pagos/docs/diagramas` → `pagos`) y se puede renombrar.
- El servidor vigila el archivo: si lo cambia otro proceso (el CLI, a mano), la vista se actualiza sola.

## Rutas

Toda ruta que viaja entre la interfaz y el servidor es **global**: `<id>/<ruta dentro de la raíz de la referencia>`. Por ejemplo, `pagos/envios/detalle.excalidraw`, que también es la URL: `http://localhost:4747/#/pagos/envios/detalle.excalidraw`. Dos repos pueden tener un `panorama.excalidraw` cada uno sin chocar.

La **raíz** de una referencia es:

- **Carpeta:** la carpeta misma.
- **Diagrama suelto:** la raíz del repo que lo contiene (la carpeta más cercana hacia arriba que tiene `.git`) o, si no está en un repo, su carpeta. Así sus links pueden llevar a otros diagramas del mismo repo aunque no estén en la vista: se abren igual, solo que no aparecen en la barra lateral.

El servidor solo lee y escribe dentro de las raíces de las referencias.

## Links

Los links guardados en los diagramas **no cambian**: siguen siendo relativos a la raíz de los diagramas del repo (`/pagos/detalle.excalidraw#id`), así el repo sigue autocontenido y abre igual en excalidraw.com o con el MCP.

Para abrir un link, se busca el destino desde la raíz de la referencia hacia la carpeta del diagrama de origen, y gana el primero que existe. Si el diagrama es `pagos/docs/diagramas/panorama.excalidraw` y el link es `/envios/detalle.excalidraw`, se prueba `pagos/envios/detalle.excalidraw`, después `pagos/docs/envios/detalle.excalidraw` y por último `pagos/docs/diagramas/envios/detalle.excalidraw`. Eso hace que funcionen tanto los links que escribió el MCP (relativos a `docs/diagramas`) como una referencia a la raíz del repo o a un diagrama suelto. Si no existe en ningún lado, el link no abre nada.

Al crear un link desde la interfaz se imita a los links que el diagrama ya tiene: se usa la misma base contra la que esos links se resolvieron (así, en un repo cuyo MCP usa `--root docs/diagramas`, los links nuevos quedan relativos a `docs/diagramas`). Si el diagrama todavía no tiene links, se escribe relativo a la raíz de la referencia; en un diagrama suelto, relativo a su carpeta. Al renombrar o mover, los links entrantes se reescriben con esa misma regla y conservan su base. Solo se puede linkear dentro de la misma referencia. Los links entre repos quedan para cuando exista la versión en la nube.

## Interfaz

- Botón «Agregar a la vista» en la barra lateral: pegás la ruta de una carpeta o de un `.excalidraw` (acepta `~`, con autocompletado).
- Menú de una referencia: nuevo diagrama, nueva carpeta, renombrar (cambia el `id`) y quitar de la vista.
- Crear un diagrama al lado de un diagrama suelto lo agrega a la vista como otra referencia, para que no quede escondido.
- Renombrar o mover entre referencias distintas no se puede: son repos distintos.

## CLI

Un servidor, de fondo:

| Comando | Qué hace |
|---|---|
| `serrugrams` | Levanta el servidor si no está corriendo y abre el navegador. |
| `serrugrams <ruta>…` | Lo mismo, y agrega esas rutas a la vista. |
| `serrugrams ls` | El estado del servidor y las referencias. |
| `serrugrams remove <id\|ruta>` | Quita una referencia de la vista. |
| `serrugrams stop` | Apaga el servidor. |
| `serrugrams logs [-f]` | Lo que imprimió el servidor. |
| `serrugrams --fg` | En primer plano, en la terminal. |
| `serrugrams mcp --root <carpeta>` | Sin cambios. |

`pnpm dev` usa su propio archivo de referencias (`.serrugrams/workspace.dev.json`, con `examples/`) y su API en el puerto 4848, para no chocar con el servidor de todos los días.

## Para más adelante

- Links entre repos.
- Una herramienta del MCP para sumar a la vista lo que Claude acaba de diagramar.
- Seguridad multiusuario y nube: ver [cloud.md](cloud.md).
