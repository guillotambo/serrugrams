// En qué modo corre la interfaz, y qué puede hacer en cada uno. Un solo lugar para estas decisiones:
//   local  → el servidor de tu máquina (server/index.ts): todo, con la vista de varias referencias y eventos en vivo.
//   sitio  → archivos estáticos de `serrugrams site`: solo lectura (src/site.ts).
//   nube   → la API de Vercel (server/cloud.ts): se edita todo, con contraseña, sobre una sola carpeta.
// Lo marca una <meta> en el index.html que arma cada comando; sin ninguna, es local.
const meta = (name: string) => (typeof document !== "undefined" ? document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`) : null);
const siteMeta = meta("serrugrams-site");

export const SITE = !!siteMeta;
/** Se publicaron los comentarios (`serrugrams site --comments`); si no, ni se piden. */
export const SITE_COMMENTS = siteMeta?.content === "comments";
export const CLOUD = !SITE && !!meta("serrugrams-cloud");

/** No se puede crear, editar, mover ni comentar. */
export const READ_ONLY = SITE;
/** Hay una vista que se arma con carpetas del disco: agregar, quitar y renombrar referencias, soltar desde Finder. */
export const MANAGE_VIEW = !SITE && !CLOUD;
/** El servidor avisa al instante cuando algo cambia (SSE). En la nube se relee al volver a la pestaña. */
export const LIVE_EVENTS = !SITE && !CLOUD;
