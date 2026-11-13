// API del modo nube: la misma que usa la UI en local (server/index.ts), sobre un solo Workspace (Vercel Blob en
// producción) y detrás de una contraseña. No trae lo que solo tiene sentido en tu máquina: la vista con varias
// referencias, el selector de carpetas, ubicar lo soltado desde Finder ni los eventos en vivo. Ver docs/nube.md.
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createHmac, timingSafeEqual } from "node:crypto";
import { emptyDiagram, resolveLinkTarget, type RefInfo, type RelPath, type TreeEntry, type TreeResponse } from "../shared/types.ts";
import { Workspace, WorkspaceError } from "./workspace.ts";

export interface CloudOptions {
  ws: Workspace;
  /** Sin contraseña configurada no se sirve nada: mejor cerrado que abierto por error. */
  password: string | undefined;
  /** Nombre de la única referencia: el primer tramo de las rutas que ve la UI. */
  refId?: string;
  /** Cookie solo por HTTPS (en Vercel, sí; probando en localhost, no). */
  secure?: boolean;
}

export const SESSION_COOKIE = "serrugrams_session";
const SESSION_DAYS = 30;

/** El valor de la cookie: deriva de la contraseña, así cambiarla cierra todas las sesiones. */
function sessionToken(password: string): string {
  return createHmac("sha256", password).update("serrugrams-session-v1").digest("hex");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function cloudApp(opts: CloudOptions): Hono {
  const { ws } = opts;
  const refId = opts.refId ?? "nube";
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof WorkspaceError) return c.json({ error: err.message }, err.status as any);
    console.error(err);
    return c.json({ error: "Error interno" }, 500);
  });

  // --- Defensas, en orden: configurada, mismo origen para escribir, sesión ---
  app.use("/api/*", async (c, next) => {
    if (!opts.password) return c.json({ error: "Falta configurar SERRUGRAMS_PASSWORD en el servidor" }, 503);
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") {
      // Un formulario de otra web no puede mandar JSON sin preflight; y si el navegador dice de dónde viene, tiene que ser de acá.
      if (!(c.req.header("content-type") ?? "").includes("application/json")) return c.json({ error: "Se requiere JSON" }, 415);
      const origin = c.req.header("origin");
      if (origin) {
        let host = "";
        try {
          host = new URL(origin).host;
        } catch {}
        if (host !== (c.req.header("x-forwarded-host") ?? c.req.header("host"))) return c.json({ error: "Origen no permitido" }, 403);
      }
    }
    if (c.req.path === "/api/login") return next();
    const cookie = getCookie(c, SESSION_COOKIE) ?? "";
    if (!same(cookie, sessionToken(opts.password))) return c.json({ error: "Hace falta la contraseña" }, 401);
    await next();
  });

  // --- Sesión ---
  app.post("/api/login", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.password !== "string" || !same(body.password, opts.password!)) return c.json({ error: "Contraseña incorrecta" }, 401);
    setCookie(c, SESSION_COOKIE, sessionToken(opts.password!), { httpOnly: true, secure: opts.secure, sameSite: "Lax", path: "/", maxAge: SESSION_DAYS * 86400 });
    return c.json({ ok: true });
  });
  app.post("/api/logout", (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
    return c.json({ ok: true });
  });
  app.get("/api/session", (c) => c.json({ ok: true }));

  // --- Rutas globales: `<refId>/<ruta>` como en local, con una sola referencia ---
  const rel = (global: unknown): RelPath => {
    if (typeof global !== "string" || !global.startsWith(refId + "/")) throw new WorkspaceError(404, "No está en la nube");
    return ws.check(global.slice(refId.length + 1));
  };
  const q = (c: Context, name: string): string => {
    const v = c.req.query(name);
    if (!v) throw new WorkspaceError(400, `Falta el parámetro ${name}`);
    return v;
  };

  app.get("/api/tree", async (c) => {
    const own = (await ws.tree()).map((e) => ({ ...e, path: `${refId}/${e.path}` }));
    const files = new Set(own.filter((e) => e.type === "file").map((e) => e.path));
    const entries: TreeEntry[] = [
      // La raíz siempre está, aunque no haya nada todavía: es donde se crea el primer diagrama.
      { path: refId, type: "dir" },
      ...own.map((e) => (e.links ? { ...e, links: [...new Set(e.links.map((l) => resolveLinkTarget(e.path, l, (p) => files.has(p))))] } : e)),
    ];
    const ref: RefInfo = { id: refId, path: refId, kind: "folder", root: refId };
    return c.json({ refs: [ref], entries } satisfies TreeResponse);
  });

  app.get("/api/file", async (c) => {
    const p = q(c, "path");
    const { content, hash } = await ws.readDiagram(rel(p));
    return c.json({ path: p, content, hash });
  });
  app.put("/api/file", async (c) => {
    const body = await c.req.json();
    return c.json({ hash: await ws.writeDiagram(rel(q(c, "path")), body.content, { baseHash: body.baseHash }) });
  });
  app.post("/api/file", async (c) => {
    const body = await c.req.json();
    const r = rel(body.path);
    const hash = await ws.writeDiagram(r, body.content ?? emptyDiagram(), { mustNotExist: true });
    if (body.comments) await ws.writeComments(r, body.comments);
    return c.json({ hash });
  });
  app.delete("/api/entry", async (c) => {
    await ws.trash(rel(q(c, "path")));
    return c.json({ ok: true });
  });
  app.post("/api/rename", async (c) => {
    const body = await c.req.json();
    await ws.rename(rel(body.from), rel(body.to));
    return c.json({ ok: true });
  });
  app.post("/api/dir", async (c) => {
    const body = await c.req.json();
    await ws.mkdir(rel(body.path));
    return c.json({ ok: true });
  });
  app.get("/api/comments", async (c) => c.json(await ws.readComments(rel(q(c, "path")))));
  app.put("/api/comments", async (c) => {
    await ws.writeComments(rel(q(c, "path")), await c.req.json());
    return c.json({ ok: true });
  });

  app.all("/api/*", (c) => c.json({ error: "No existe en la nube" }, 404));
  return app;
}
