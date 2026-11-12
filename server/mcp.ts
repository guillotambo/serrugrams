#!/usr/bin/env node
// Servidor MCP (stdio) de Serrugrams: permite a agentes leer y editar diagramas de
// Excalidraw del workspace. Solo escribe archivos; la UI (si está abierta) los
// recibe en vivo por el watcher del servidor HTTP.
//
// Uso: node server/mcp.ts [--root <dir>]   (o env SERRUGRAMS_ROOT; por defecto cwd)
// Nunca escribir en stdout fuera del protocolo: los logs van a stderr.
import path from "node:path";
import { promises as fs } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Workspace, WorkspaceError, newId } from "./workspace.ts";
import { DIAGRAM_EXT, emptyDiagram, makeDiagramLink, parseDiagramLink, type Comment, type ExcalidrawFile, type RelPath } from "../shared/types.ts";
import { appendToScene, buildScene, deleteElements, summarizeScene, updateElement, BuilderError, isLive, type El } from "./builder.ts";

const log = (...a: unknown[]) => console.error("[serrugrams-mcp]", ...a);

// --- Raíz del workspace ---
function rootFromArgs(): string {
  const args = process.argv.slice(2);
  const i = args.indexOf("--root");
  const fromFlag = i >= 0 ? args[i + 1] : args.find((a) => a.startsWith("--root="))?.slice(7);
  return path.resolve(fromFlag ?? process.env.SERRUGRAMS_ROOT ?? process.cwd());
}
const root = rootFromArgs();
await fs.mkdir(root, { recursive: true });
const ws = new Workspace(root);

// --- Helpers ---
class ToolError extends Error {}

/** Acepta "a/b.excalidraw", "/a/b.excalidraw" o el formato link "/a/b.excalidraw#id" (se ignora el #). */
function normPath(p: string, what = "path"): RelPath {
  if (typeof p !== "string" || !p.trim()) throw new ToolError(`Falta ${what}.`);
  let s = p.trim();
  const parsed = parseDiagramLink(s.startsWith("/") ? s : "/" + s);
  if (parsed) s = parsed.path;
  s = s.replace(/^\/+/, "").replace(/\\/g, "/");
  if (!s.endsWith(DIAGRAM_EXT)) throw new ToolError(`${what} debe terminar en ${DIAGRAM_EXT} (recibido "${p}").`);
  return s;
}

async function read(p: RelPath): Promise<{ content: ExcalidrawFile; hash: string }> {
  return ws.readDiagram(p);
}

/**
 * Lee, aplica `fn` y escribe con baseHash para no pisar ediciones concurrentes
 * (p.ej. la UI). Ante un 409 vuelve a leer y reintenta una vez.
 */
async function mutate<R>(p: RelPath, fn: (content: ExcalidrawFile) => R): Promise<R> {
  for (let attempt = 0; ; attempt++) {
    const { content, hash } = await read(p);
    const result = fn(content);
    try {
      await ws.writeDiagram(p, content, { baseHash: hash });
      return result;
    } catch (e) {
      if (e instanceof WorkspaceError && e.status === 409 && attempt === 0) {
        log(`conflicto al escribir ${p}, reintentando`);
        continue;
      }
      throw e;
    }
  }
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const json = (v: unknown) => JSON.stringify(v, null, 1);

function handle<A>(fn: (args: A) => Promise<string>): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e: any) {
      const known = e instanceof ToolError || e instanceof BuilderError || e instanceof WorkspaceError;
      if (!known) log("error inesperado:", e?.stack ?? e);
      return { content: [{ type: "text", text: `Error: ${e?.message ?? String(e)}` }], isError: true };
    }
  };
}

function liveById(content: ExcalidrawFile, id: string): El | undefined {
  return content.elements.find((e: El) => e.id === id && isLive(e));
}

// --- Esquemas ---
const nodeSchema = z.object({
  id: z.string().optional().describe("Stable, readable id, e.g. \"api\" or \"orders-db\". Letters, digits, _ - . only. Generated if omitted. Edges can reference it."),
  type: z.enum(["rectangle", "ellipse", "diamond", "text"]).optional().describe("Default rectangle. ellipse = datastore/actor, diamond = decision, text = free annotation (no box)."),
  label: z.string().optional().describe("Short label (1-4 words). Use \\n for a second line, e.g. \"Orders\\n(Go)\"."),
  x: z.number().optional().describe("Top-left x. Give x AND y to pin a node; otherwise it is auto-laid out."),
  y: z.number().optional(),
  width: z.number().optional().describe("Optional; by default sized to fit the label."),
  height: z.number().optional(),
  backgroundColor: z.string().optional().describe("e.g. \"#a5d8ff\" (blue), \"#b2f2bb\" (green), \"#ffec99\" (yellow), \"#ffc9c9\" (red), \"#d0bfff\" (violet), \"transparent\"."),
  strokeColor: z.string().optional(),
  link: z.string().optional().describe("Diagram to drill into, e.g. \"payments/detail.excalidraw\" or \"payments/detail.excalidraw#elementId\". Stored as \"/payments/detail.excalidraw#elementId\"."),
  customData: z.record(z.string(), z.unknown()).optional().describe("Metadata, e.g. {\"service\":\"orders\",\"repo\":\"org/orders\",\"team\":\"checkout\"}."),
});
const edgeSchema = z.object({
  from: z.string().describe("Source node id (from this call or already in the diagram). An exact unique label also works."),
  to: z.string().describe("Target node id or exact unique label."),
  label: z.string().optional().describe("Short protocol/verb, e.g. \"HTTPS\", \"gRPC\", \"publishes\"."),
  style: z.enum(["solid", "dashed", "dotted"]).optional().describe("solid = sync call (default), dashed = async/event, dotted = optional/weak dependency."),
  arrowhead: z.enum(["arrow", "none"]).optional().describe("\"none\" draws a plain connector."),
  bidirectional: z.boolean().optional(),
  strokeColor: z.string().optional(),
});
const pathArg = z.string().describe(`Diagram path relative to the workspace root, ending in ${DIAGRAM_EXT}, e.g. "overview.excalidraw" or "payments/detail.excalidraw".`);
const directionArg = z.enum(["LR", "TB"]).optional().describe("Auto-layout direction for nodes without x/y: LR = left to right (default), TB = top to bottom.");
const authorArg = z.string().optional().describe("Defaults to \"agent\".");

// --- Servidor ---
const CONVENTIONS = `Serrugrams: system-design diagrams as Excalidraw files (*.excalidraw) in a folder (workspace).

Conventions:
- Paths are relative to the workspace root, e.g. "overview.excalidraw", "payments/detail.excalidraw".
- Keep ONE high-level diagram (e.g. "overview.excalidraw") with one box per system/service, and link each box to its detail diagram with link_element (or the node "link" field). Detail diagrams live in folders, e.g. "payments/detail.excalidraw".
- Links are stored in the element's native "link" field as "/<path>.excalidraw" or "/<path>.excalidraw#<elementId>" to focus an element. Tools accept the path with or without the leading "/".
- Put machine-readable metadata in node customData, e.g. {"service":"orders","repo":"org/orders","team":"checkout","owner":"@ana"}.
- Keep labels short (1-4 words). Put explanations in comments (add_comment) or free text nodes, not in box labels.
- Edges: solid = synchronous request, dashed = async/event/queue, dotted = optional. Label edges with the protocol or verb ("HTTPS", "gRPC", "publishes OrderPaid").
- Shapes: rectangle = service/component, ellipse = datastore/external actor, diamond = decision.
- Give nodes readable ids ("api", "orders-db") so you can reference them later; omit x/y to auto-layout.
- Always read_diagram before editing an existing diagram; the user may have changed it in the UI.
- Comments are review threads anchored to an element (or a point). Use list_comments to find open feedback, reply_comment to answer, resolve_comment when addressed.`;

const server = new McpServer({ name: "serrugrams", version: "0.1.0" }, { instructions: CONVENTIONS });

server.registerPrompt(
  "system_design_conventions",
  { title: "Serrugrams conventions", description: "How to structure system-design diagrams in Serrugrams (overview + linked detail diagrams, customData, labels)." },
  () => ({ messages: [{ role: "user", content: { type: "text", text: CONVENTIONS } }] }),
);

server.registerTool(
  "list_diagrams",
  {
    title: "List diagrams",
    description: "List every diagram in the workspace with the diagrams each one links to and its number of open (unresolved) comments. Start here to understand the structure (overview -> detail diagrams).",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  handle(async () => {
    const entries = (await ws.tree()).filter((e) => e.type === "file");
    if (!entries.length) return `No diagrams yet in ${ws.root}. Create one with create_diagram (e.g. "overview.excalidraw").`;
    return json({ root: ws.root, diagrams: entries.map((e) => ({ path: e.path, linksTo: e.links ?? [], openComments: e.openComments ?? 0 })) });
  }),
);

server.registerTool(
  "read_diagram",
  {
    title: "Read diagram",
    description:
      "Read a diagram as a compact summary: nodes (id, type, label, x, y, w, h, link, customData), edges (id, from, to, label, style) and free texts. Label text elements bound to shapes/arrows are folded into their owner (you never need their ids). Also returns open comment count. Pass raw: true only if you need the full Excalidraw elements JSON.",
    inputSchema: { path: pathArg, raw: z.boolean().optional().describe("Also include the raw Excalidraw elements array (large).") },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ path: p, raw }: { path: string; raw?: boolean }) => {
    const rel = normPath(p);
    const { content } = await read(rel);
    const comments = await ws.readComments(rel);
    const out: Record<string, unknown> = { path: rel, ...summarizeScene(content.elements), openComments: comments.comments.filter((c) => !c.resolved).length };
    if (raw) out.elements = content.elements;
    return json(out);
  }),
);

server.registerTool(
  "create_diagram",
  {
    title: "Create diagram",
    description:
      "Create a new diagram from nodes and edges. Nodes without x/y are auto-laid out (layered graph layout following the edges). Fails if the file exists unless overwrite: true. Folders are created as needed. Returns the created ids. Example: nodes [{id:\"web\",label:\"Web\"},{id:\"api\",label:\"API\",link:\"api/detail.excalidraw\"},{id:\"db\",type:\"ellipse\",label:\"Postgres\"}], edges [{from:\"web\",to:\"api\",label:\"HTTPS\"},{from:\"api\",to:\"db\"}].",
    inputSchema: {
      path: pathArg,
      nodes: z.array(nodeSchema).default([]),
      edges: z.array(edgeSchema).default([]),
      direction: directionArg,
      overwrite: z.boolean().optional().describe("Replace an existing diagram (its comments are kept)."),
    },
  },
  handle(async ({ path: p, nodes, edges, direction, overwrite }: { path: string; nodes: any[]; edges: any[]; direction?: "LR" | "TB"; overwrite?: boolean }) => {
    const rel = normPath(p);
    const exists = await ws.exists(rel);
    if (exists && !overwrite) throw new ToolError(`${rel} already exists. Use add_elements to extend it, or overwrite: true to replace it.`);
    const built = buildScene(nodes ?? [], edges ?? [], { direction });
    const content = emptyDiagram();
    content.elements = built.elements;
    await ws.writeDiagram(rel, content, exists ? {} : { mustNotExist: true });
    return json({ created: rel, nodes: built.nodeIds, edges: built.edgeIds });
  }),
);

server.registerTool(
  "add_elements",
  {
    title: "Add elements",
    description:
      "Add nodes and/or edges to an existing diagram. Edges may connect new nodes and/or existing element ids (see read_diagram). New nodes without x/y are auto-laid out and placed next to the existing content without overlapping.",
    inputSchema: { path: pathArg, nodes: z.array(nodeSchema).default([]), edges: z.array(edgeSchema).default([]), direction: directionArg },
  },
  handle(async ({ path: p, nodes, edges, direction }: { path: string; nodes: any[]; edges: any[]; direction?: "LR" | "TB" }) => {
    const rel = normPath(p);
    if (!(nodes?.length || edges?.length)) throw new ToolError("Nothing to add: pass nodes and/or edges.");
    const r = await mutate(rel, (content) => {
      const res = appendToScene(content.elements, nodes ?? [], edges ?? [], { direction });
      content.elements = res.elements;
      return res;
    });
    return json({ updated: rel, nodes: r.nodeIds, edges: r.edgeIds });
  }),
);

server.registerTool(
  "update_element",
  {
    title: "Update element",
    description:
      "Patch one node, edge or free text. Fields: label (\"\" removes it), x/y (moves the node; attached arrows are re-routed), width/height, backgroundColor, strokeColor, link (diagram path, or null to unlink), customData (shallow merge; a key set to null is removed; customData: null clears all), style (edges only). Passing the id of a label text updates its owner.",
    inputSchema: {
      path: pathArg,
      id: z.string().describe("Element id from read_diagram."),
      patch: z.object({
        label: z.string().optional(),
        x: z.number().optional(),
        y: z.number().optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        backgroundColor: z.string().optional(),
        strokeColor: z.string().optional(),
        link: z.string().nullable().optional().describe("e.g. \"payments/detail.excalidraw\"; null removes the link. Prefer link_element, which checks the target exists."),
        customData: z.record(z.string(), z.unknown()).nullable().optional(),
        style: z.enum(["solid", "dashed", "dotted"]).optional(),
      }),
    },
  },
  handle(async ({ path: p, id, patch }: { path: string; id: string; patch: any }) => {
    const rel = normPath(p);
    const r = await mutate(rel, (content) => {
      const res = updateElement(content.elements, id, patch ?? {});
      content.elements = res.elements;
      return { id: res.id, summary: summarizeScene(res.elements) };
    });
    const node = [...r.summary.nodes, ...r.summary.edges, ...r.summary.texts].find((n) => n.id === r.id);
    return json({ updated: rel, element: node ?? { id: r.id } });
  }),
);

server.registerTool(
  "delete_elements",
  {
    title: "Delete elements",
    description: "Delete elements by id. Deleting a node also deletes its label and every arrow attached to it; deleting an arrow keeps its nodes. References are cleaned up.",
    inputSchema: { path: pathArg, ids: z.array(z.string()).min(1) },
    annotations: { destructiveHint: true },
  },
  handle(async ({ path: p, ids }: { path: string; ids: string[] }) => {
    const rel = normPath(p);
    const r = await mutate(rel, (content) => {
      const res = deleteElements(content.elements, ids);
      content.elements = res.elements;
      return res;
    });
    if (r.notFound.length === ids.length) throw new ToolError(`None of these ids exist in ${rel}: ${r.notFound.join(", ")}. Use read_diagram to see valid ids.`);
    return json({ updated: rel, removed: r.removed, notFound: r.notFound });
  }),
);

server.registerTool(
  "link_element",
  {
    title: "Link element to diagram",
    description:
      "Make an element (usually a box in a high-level diagram) open another diagram when clicked: sets element.link to \"/<target_path>\" or \"/<target_path>#<target_element_id>\". The target must exist unless create_target: true (creates an empty diagram). Pass target_path: null to remove the link.",
    inputSchema: {
      path: pathArg,
      id: z.string().describe("Element id in `path`."),
      target_path: z.string().nullable().describe(`Diagram to link to, e.g. "payments/detail.excalidraw"; null unlinks.`),
      target_element_id: z.string().optional().describe("Optional element in the target diagram to focus."),
      create_target: z.boolean().optional().describe("Create the target diagram empty if it does not exist."),
    },
  },
  handle(async ({ path: p, id, target_path, target_element_id, create_target }: { path: string; id: string; target_path: string | null; target_element_id?: string; create_target?: boolean }) => {
    const rel = normPath(p);
    let link: string | null = null;
    let createdTarget = false;
    if (target_path != null) {
      const target = normPath(target_path, "target_path");
      if (!(await ws.exists(target))) {
        if (!create_target) throw new ToolError(`Target ${target} does not exist. Create it first (create_diagram) or pass create_target: true.`);
        if (target_element_id) throw new ToolError("target_element_id cannot be used with a target that does not exist yet.");
        try {
          await ws.writeDiagram(target, emptyDiagram(), { mustNotExist: true });
          createdTarget = true;
        } catch (e) {
          if (!(e instanceof WorkspaceError && e.status === 409)) throw e;
        }
      } else if (target_element_id) {
        const t = await read(target);
        if (!liveById(t.content, target_element_id)) throw new ToolError(`Element ${target_element_id} does not exist in ${target}.`);
      }
      link = makeDiagramLink(target, target_element_id);
    }
    await mutate(rel, (content) => {
      if (!liveById(content, id)) throw new ToolError(`Element ${id} does not exist in ${rel}. Use read_diagram to see valid ids.`);
      content.elements = updateElement(content.elements, id, { link }).elements;
    });
    return link ? `Linked ${rel}#${id} -> ${link}${createdTarget ? " (target created empty)" : ""}` : `Removed link from ${rel}#${id}`;
  }),
);

server.registerTool(
  "rename_diagram",
  {
    title: "Rename or move diagram",
    description:
      "Rename/move a diagram (its comments move with it). Links in other diagrams that pointed to the old path are rewritten to the new one; the result lists which diagrams were updated.",
    inputSchema: { from: pathArg, to: pathArg },
  },
  handle(async ({ from, to }: { from: string; to: string }) => {
    const src = normPath(from, "from");
    const dst = normPath(to, "to");
    // Quién linkeaba al origen (se escanea cada archivo; el cache de tree() depende del mtime).
    const linksIn = async (target: RelPath): Promise<string[]> => {
      const out: string[] = [];
      for (const e of await ws.tree()) {
        if (e.type !== "file") continue;
        try {
          const { content } = await read(e.path);
          if (content.elements.some((el: El) => isLive(el) && parseDiagramLink(el.link)?.path === target)) out.push(e.path);
        } catch {}
      }
      return out;
    };
    const before = (await linksIn(src)).map((p) => (p === src ? dst : p));
    // Workspace.rename mueve el sidecar de comentarios y reescribe los links entrantes.
    await ws.rename(src, dst);
    const after = new Set(await linksIn(dst));
    const stale = new Set(await linksIn(src));
    const updated = before.filter((p) => after.has(p) && !stale.has(p));
    const failed = before.filter((p) => !updated.includes(p));
    return json({ renamed: { from: src, to: dst }, linksUpdatedIn: updated, ...(failed.length ? { linksNotUpdated: failed } : {}) });
  }),
);

// --- Comentarios ---
// Nota: Workspace.writeComments no tiene control de concurrencia (sin hash); se
// re-lee justo antes de escribir para achicar la ventana de carrera.
function commentPos(c: Comment, elements: El[]): { x: number; y: number } {
  const el = c.anchor.elementId ? elements.find((e) => e.id === c.anchor.elementId && isLive(e)) : undefined;
  if (el) return { x: el.x + (c.anchor.offset?.x ?? 0), y: el.y + (c.anchor.offset?.y ?? 0) };
  return { x: c.anchor.x, y: c.anchor.y };
}

async function findComment(rel: RelPath, commentId: string) {
  const data = await ws.readComments(rel);
  const c = data.comments.find((x) => x.id === commentId);
  if (!c) throw new ToolError(`Comment ${commentId} does not exist in ${rel}. Use list_comments.`);
  return { data, c };
}

server.registerTool(
  "list_comments",
  {
    title: "List comments",
    description: "List comment threads of a diagram (open first), each with its anchor element (id + label, if any), position, author, resolved flag and replies.",
    inputSchema: { path: pathArg, include_resolved: z.boolean().optional().describe("Default true.") },
    annotations: { readOnlyHint: true },
  },
  handle(async ({ path: p, include_resolved }: { path: string; include_resolved?: boolean }) => {
    const rel = normPath(p);
    const { content } = await read(rel);
    const summary = summarizeScene(content.elements);
    const labelOf = new Map<string, string | undefined>([...summary.nodes.map((n) => [n.id, n.label] as const), ...summary.edges.map((e) => [e.id, e.label] as const), ...summary.texts.map((t) => [t.id, t.text] as const)]);
    const data = await ws.readComments(rel);
    const list = data.comments
      .filter((c) => include_resolved !== false || !c.resolved)
      .sort((a, b) => Number(a.resolved) - Number(b.resolved) || a.createdAt.localeCompare(b.createdAt))
      .map((c) => {
        const elementExists = !!c.anchor.elementId && labelOf.has(c.anchor.elementId);
        return {
          id: c.id,
          resolved: c.resolved,
          author: c.author,
          createdAt: c.createdAt,
          text: c.text,
          ...(c.anchor.elementId ? { elementId: c.anchor.elementId, elementLabel: labelOf.get(c.anchor.elementId), ...(elementExists ? {} : { elementMissing: true }) } : {}),
          at: commentPos(c, content.elements),
          replies: c.replies.map((r) => ({ id: r.id, author: r.author, createdAt: r.createdAt, text: r.text })),
        };
      });
    if (!list.length) return `No comments in ${rel}.`;
    return json({ path: rel, comments: list });
  }),
);

server.registerTool(
  "add_comment",
  {
    title: "Add comment",
    description:
      "Start a comment thread on a diagram, anchored to an element (element_id; the pin follows the element when it moves) or to a scene point (x, y). With element_id and no x/y the pin goes at the element's top-right corner; with both, x/y is an absolute scene point and the offset to the element is stored.",
    inputSchema: {
      path: pathArg,
      text: z.string().min(1),
      element_id: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
      author: authorArg,
    },
  },
  handle(async ({ path: p, text, element_id, x, y, author }: { path: string; text: string; element_id?: string; x?: number; y?: number; author?: string }) => {
    const rel = normPath(p);
    const { content } = await read(rel);
    let anchor: Comment["anchor"];
    if (element_id) {
      const el = liveById(content, element_id);
      if (!el) throw new ToolError(`Element ${element_id} does not exist in ${rel}. Use read_diagram to see valid ids.`);
      const ax = x ?? el.x + Math.abs(el.width ?? 0);
      const ay = y ?? el.y;
      anchor = { elementId: el.id, offset: { x: ax - el.x, y: ay - el.y }, x: ax, y: ay };
    } else {
      if (x == null || y == null) throw new ToolError("Pass element_id, or both x and y.");
      anchor = { x, y };
    }
    const comment: Comment = { id: newId(), anchor, author: author || "agent", createdAt: new Date().toISOString(), resolved: false, text, replies: [] };
    const data = await ws.readComments(rel);
    data.comments.push(comment);
    await ws.writeComments(rel, data);
    return json({ added: comment.id, path: rel, anchor });
  }),
);

server.registerTool(
  "reply_comment",
  {
    title: "Reply to comment",
    description: "Reply to a comment thread (use list_comments to get ids).",
    inputSchema: { path: pathArg, comment_id: z.string(), text: z.string().min(1), author: authorArg },
  },
  handle(async ({ path: p, comment_id, text, author }: { path: string; comment_id: string; text: string; author?: string }) => {
    const rel = normPath(p);
    const { data, c } = await findComment(rel, comment_id);
    const reply = { id: newId(), author: author || "agent", createdAt: new Date().toISOString(), text };
    c.replies.push(reply);
    await ws.writeComments(rel, data);
    return json({ replied: comment_id, reply: reply.id });
  }),
);

server.registerTool(
  "resolve_comment",
  {
    title: "Resolve comment",
    description: "Mark a comment thread as resolved (or reopen it with resolved: false).",
    inputSchema: { path: pathArg, comment_id: z.string(), resolved: z.boolean().optional().describe("Default true.") },
  },
  handle(async ({ path: p, comment_id, resolved }: { path: string; comment_id: string; resolved?: boolean }) => {
    const rel = normPath(p);
    const { data, c } = await findComment(rel, comment_id);
    c.resolved = resolved ?? true;
    await ws.writeComments(rel, data);
    return `${c.resolved ? "Resolved" : "Reopened"} comment ${comment_id} in ${rel}`;
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
log(`listo, workspace: ${ws.root}`);
