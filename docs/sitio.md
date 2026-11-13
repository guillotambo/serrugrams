# Sitio de solo lectura

`serrugrams site` arma una carpeta de archivos estáticos con la interfaz de siempre en **solo lectura** y los diagramas que elijas. Sirve para mirar y compartir diagramas desde cualquier lado sin instalar nada: se sube a Vercel, o a cualquier hosting de archivos, tal cual.

No reemplaza el modo local: los diagramas se siguen editando en tu máquina (con la app o con el MCP) y el sitio se vuelve a generar cuando querés publicar una versión nueva.

```bash
pnpm build                                     # la UI sale de dist/ui
serrugrams site ~/code/pagos/docs/diagramas    # → ./serrugrams-site
serrugrams site docs/diagramas otro/panorama.excalidraw --out /tmp/sitio --comments
```

- **Rutas explícitas.** Se publica lo que le pasás: carpetas o diagramas sueltos. No usa ni toca tu vista (`~/.serrugrams/workspace.json`).
- **Un diagrama suelto no publica su repo.** Además de ese diagrama, solo van los que se alcanzan siguiendo sus links, igual que en la app.
- **Sin rutas del disco.** El árbol publicado lleva el nombre de cada referencia y de su carpeta, nunca la ruta absoluta.
- **Comentarios, solo con `--comments`.** Suelen ser notas de revisión con nombres; por defecto no viajan, ni siquiera el contador.
- **La salida se reescribe entera** en cada corrida. Por seguridad solo pisa una carpeta vacía o una salida anterior (la marca el archivo `.serrugrams-site`); la carpeta `.vercel` se conserva.
- El `index.html` lleva `<meta name="robots" content="noindex">`.

## Qué se ve

La misma interfaz: explorador, links entre diagramas (con foco por `#elemento`), historial, buscador (`⌘P`), conexiones «se llega desde / lleva a», comentarios (si se publicaron) y exportar a PNG/SVG. Excalidraw abre en modo vista. No hay crear, renombrar, mover, borrar, linkear, comentar ni guardar.

Cada diagrama tiene su URL (`https://…/#/<referencia>/<ruta>.excalidraw`), y sin diagrama en la URL se abre el `panorama.excalidraw` de la primera referencia.

## Cómo funciona

```
serrugrams-site/
  index.html                  la UI de dist/ui, con <meta name="serrugrams-site">
  assets/, fonts/, …
  data/tree.json              el árbol (como GET /api/tree, sin rutas absolutas)
  data/files/<ruta global>    cada diagrama, y con --comments su .comments.json
```

La etiqueta `<meta name="serrugrams-site">` pone la UI en modo sitio (`src/site.ts`): lee `data/` en vez de `/api`, no abre la conexión de eventos y esconde las acciones que escriben. Lo que se haya escapado falla con «Este sitio es de solo lectura» en vez de pedirle algo a un servidor que no existe. Sin la etiqueta, la app es exactamente la de siempre. El ruteo es por hash, así que no hace falta ninguna regla de rewrite en el hosting.

## Publicar en Vercel

```bash
serrugrams site docs/diagramas
npx vercel deploy serrugrams-site          # preview
npx vercel deploy serrugrams-site --prod   # producción
```

La primera vez, Vercel pregunta en qué cuenta y con qué nombre crear el proyecto (con `--yes`, el nombre de la carpeta), y deja `serrugrams-site/.vercel` para las siguientes. **El primer deploy de un proyecto va siempre a producción**, aunque no pases `--prod`; recién los siguientes son previews.

**Quién lo puede ver.** Lo que se publica queda en los servidores de Vercel. Probado el 13/11/2026 en una cuenta Hobby con la protección por defecto (Standard Protection), pidiendo sin sesión:

| URL | Sin sesión de Vercel |
| --- | --- |
| `<proyecto>.vercel.app` (dominio de producción) | **Abierta**: cualquiera con el link ve todo. |
| `<proyecto>-<equipo>.vercel.app` | Redirige al login de Vercel. |
| `<proyecto>-<hash>-<equipo>.vercel.app` (cada deploy) | Redirige al login de Vercel. |

O sea: el dominio corto de producción es público, y el resto queda solo para quien tenga cuenta en tu equipo de Vercel. Proteger también los dominios o poner contraseña depende del plan, y la contraseña tiene costo aparte. Antes de publicar diagramas reales, decidí si alcanza con un link público difícil de adivinar o si tienen que quedar detrás del login. Si los diagramas no pueden salir de tu máquina sin cifrar, esto no sirve: ver la decisión de privacidad en [cloud.md](cloud.md).

**Publicar en cada push, todavía no.** Un build de Vercel en otro repo necesitaría `npx serrugrams`, y el paquete todavía no está en npm. Hoy el camino es generar el sitio en tu máquina y subir la carpeta.

## Tests

`server/site.test.ts`: qué se publica (escondidos solo por links, también encadenados), que no haya rutas absolutas, comentarios opcionales y que nunca pise una carpeta que no sea un sitio.
