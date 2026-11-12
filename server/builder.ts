// Generación y edición de elementos de Excalidraw (0.18) sin depender de @excalidraw/excalidraw,
// que no se puede importar en Node. Funciones puras: no tocan disco.
//
// Forma de los elementos verificada contra
// node_modules/@excalidraw/excalidraw/dist/types/excalidraw/element/types.d.ts (v0.18.1)
// y contra `restoreElement` del bundle (lo que Excalidraw repara al cargar).
import { randomBytes, randomInt } from "node:crypto";
import { DIAGRAM_EXT, DIAGRAM_LINK_RE, makeDiagramLink, parseDiagramLink } from "../shared/types.ts";
import { boundingBox, layeredLayout, placeBlock, LABEL_CLEARANCE, type Box, type Direction } from "./layout.ts";

export type NodeType = "rectangle" | "ellipse" | "diamond" | "text";
export type EdgeStyle = "solid" | "dashed" | "dotted";

export interface SkeletonNode {
  /** Id del elemento a crear (si se omite se genera uno). Debe ser único en la escena. */
  id?: string;
  type?: NodeType;
  label?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  strokeColor?: string;
  /** Ruta de diagrama ("pagos/detalle.excalidraw", opcional "#elementId"), link "/..." o URL http(s). */
  link?: string | null;
  customData?: Record<string, unknown>;
}

export interface SkeletonEdge {
  /** Id (o label exacto, si es único) del nodo origen: del mismo lote o ya existente en la escena. */
  from: string;
  to: string;
  label?: string;
  style?: EdgeStyle;
  arrowhead?: "arrow" | "none";
  bidirectional?: boolean;
  strokeColor?: string;
}

export interface ElementPatch {
  label?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  backgroundColor?: string;
  strokeColor?: string;
  /** null quita el link. */
  link?: string | null;
  /** Merge superficial; una clave con null se borra; customData: null borra todo. */
  customData?: Record<string, unknown> | null;
  /** Solo flechas. */
  style?: EdgeStyle;
}

export interface BuildOptions {
  direction?: Direction;
}

export class BuilderError extends Error {}

export type El = Record<string, any>;

// --- Constantes (valores por defecto de Excalidraw 0.18) ---
const FONT_FAMILY_EXCALIFONT = 5;
const LINE_HEIGHT = 1.25;
const NODE_FONT_SIZE = 20;
const EDGE_FONT_SIZE = 16;
const CHAR_WIDTH = 0.6; // ancho medio por carácter / fontSize (heurística conservadora para Excalifont)
const BOUND_TEXT_PADDING = 5; // igual que Excalidraw
const LABEL_PAD = 20;
const MIN_W = 160;
const MIN_H = 70;
const ARROW_GAP = 8;
const WRAP_AT = 26;
// Excalidraw re-envuelve el label de una flecha a max(0.7 * ancho, fontSize * 11) al cargar;
// con <= 18 caracteres por línea (16px * 0.6 * 18 = 173 < 176) nunca se re-envuelve.
const EDGE_WRAP_AT = 18;

const BINDABLE = new Set(["rectangle", "diamond", "ellipse", "text", "image", "iframe", "embeddable", "frame", "magicframe"]);
const SHAPES = new Set(["rectangle", "diamond", "ellipse"]);
const ID_RE = /^[A-Za-z0-9_.\-]{1,64}$/;

// --- Utilidades ---
export function genId(): string {
  return randomBytes(10).toString("base64url");
}
const seed = () => randomInt(1, 2 ** 31 - 1);
const r2 = (n: number) => Math.round(n * 100) / 100;

function touch(el: El): void {
  el.version = (el.version ?? 1) + 1;
  el.versionNonce = seed();
  el.updated = Date.now();
}

export function isLive(el: El): boolean {
  return !!el && !el.isDeleted;
}

function liveMap(elements: El[]): Map<string, El> {
  const m = new Map<string, El>();
  for (const el of elements) if (isLive(el)) m.set(el.id, el);
  return m;
}

function baseElement(type: string, x: number, y: number, width: number, height: number): El {
  return {
    id: genId(),
    type,
    x: r2(x),
    y: r2(y),
    width: r2(width),
    height: r2(height),
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: seed(),
    version: 1,
    versionNonce: seed(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: null,
    locked: false,
  };
}

/** Parte en líneas de hasta ~WRAP_AT caracteres por palabras (respeta los "\n" explícitos). */
export function wrapLabel(text: string, max = WRAP_AT): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= max) return line;
      const out: string[] = [];
      let cur = "";
      for (const word of line.split(/\s+/)) {
        if (!cur) cur = word;
        else if ((cur + " " + word).length <= max) cur += " " + word;
        else {
          out.push(cur);
          cur = word;
        }
      }
      if (cur) out.push(cur);
      return out.join("\n");
    })
    .join("\n");
}

export function measureText(text: string, fontSize: number): { width: number; height: number } {
  const lines = text.split("\n");
  const longest = Math.max(1, ...lines.map((l) => [...l].length));
  return { width: Math.ceil(longest * fontSize * CHAR_WIDTH), height: Math.ceil(lines.length * fontSize * LINE_HEIGHT) };
}

/** Tamaño mínimo de un contenedor para que su label entre sin re-wrap (según getBoundTextMaxWidth de Excalidraw). */
function containerSizeFor(type: string, textW: number, textH: number, withMin = true): { width: number; height: number } {
  // withMin = true: tamaño de creación (mínimos y padding generoso).
  // withMin = false: lo justo para que el texto entre según getBoundTextMaxWidth/Height de Excalidraw.
  const extra = withMin ? LABEL_PAD : 0;
  const minW = withMin ? MIN_W : 0;
  const minH = withMin ? MIN_H : 0;
  const tw = textW + 2 * BOUND_TEXT_PADDING;
  const th = textH + 2 * BOUND_TEXT_PADDING;
  if (type === "ellipse") {
    return { width: Math.max(minW, Math.ceil((tw * 2) / Math.SQRT2 + extra)), height: Math.max(minH, Math.ceil((th * 2) / Math.SQRT2 + extra)) };
  }
  if (type === "diamond") {
    return { width: Math.max(minW, Math.ceil(tw * 2 + extra)), height: Math.max(withMin ? MIN_H + 20 : 0, Math.ceil(th * 2 + extra)) };
  }
  const pad = withMin ? LABEL_PAD : BOUND_TEXT_PADDING;
  return { width: Math.max(minW, textW + 2 * pad), height: Math.max(minH, textH + 2 * pad) };
}

function makeText(text: string, fontSize: number, containerId: string | null, align: "left" | "center", wrapAt = WRAP_AT): El {
  const wrapped = containerId ? wrapLabel(text, wrapAt) : text;
  const m = measureText(wrapped, fontSize);
  const el = baseElement("text", 0, 0, m.width, m.height);
  Object.assign(el, {
    fontSize,
    fontFamily: FONT_FAMILY_EXCALIFONT,
    text: wrapped,
    originalText: text,
    textAlign: align,
    verticalAlign: containerId ? "middle" : "top",
    containerId,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
  });
  return el;
}

/** Tamaño estimado del label de una flecha, tal como se va a generar. */
export function edgeLabelSize(label: string): { labelWidth: number; labelHeight: number } {
  const m = measureText(wrapLabel(label, EDGE_WRAP_AT), EDGE_FONT_SIZE);
  return { labelWidth: m.width, labelHeight: m.height };
}

function setText(t: El, text: string, wrapAt = WRAP_AT): void {
  const wrapped = t.containerId ? wrapLabel(text, wrapAt) : text;
  const m = measureText(wrapped, t.fontSize ?? NODE_FONT_SIZE);
  t.text = wrapped;
  t.originalText = text;
  t.width = m.width;
  t.height = m.height;
  touch(t);
}

function addBound(container: El, ref: { id: string; type: "arrow" | "text" }): void {
  const list: any[] = Array.isArray(container.boundElements) ? container.boundElements : [];
  if (!list.some((b) => b.id === ref.id)) container.boundElements = [...list, ref];
  touch(container);
}

function removeBound(container: El, id: string): void {
  if (!Array.isArray(container.boundElements)) return;
  const next = container.boundElements.filter((b: any) => b.id !== id);
  if (next.length !== container.boundElements.length) {
    container.boundElements = next.length ? next : null;
    touch(container);
  }
}

function boundTextOf(el: El, map: Map<string, El>): El | null {
  for (const b of el.boundElements ?? []) {
    if (b.type === "text") {
      const t = map.get(b.id);
      if (t && t.containerId === el.id) return t;
    }
  }
  return null;
}

export function normalizeLink(link: string | null | undefined): string | null {
  if (link == null) return null;
  const s = String(link).trim();
  if (!s) return null;
  if (/^(https?:|mailto:)/i.test(s)) return s;
  if (DIAGRAM_LINK_RE.test(s)) {
    const p = parseDiagramLink(s)!;
    return makeDiagramLink(p.path, p.elementId);
  }
  const [path, elementId] = s.split("#", 2);
  if (path.endsWith(DIAGRAM_EXT)) return makeDiagramLink(path.replace(/^\/+/, ""), elementId || undefined);
  throw new BuilderError(`Link inválido "${s}": usá una ruta de diagrama como "carpeta/detalle${DIAGRAM_EXT}" (opcional "#elementId") o una URL http(s).`);
}

// --- Geometría ---
interface Pt {
  x: number;
  y: number;
}
const center = (el: El): Pt => ({ x: el.x + el.width / 2, y: el.y + el.height / 2 });

/** Punto en el borde de `el` en la dirección de `toward`, desplazado `gap` hacia afuera. */
export function borderPoint(el: El, toward: Pt, gap = ARROW_GAP): Pt {
  const c = center(el);
  let dx = toward.x - c.x;
  let dy = toward.y - c.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6)) {
    dx = 1;
    dy = 0;
  }
  const hw = Math.max(Math.abs(el.width) / 2, 1);
  const hh = Math.max(Math.abs(el.height) / 2, 1);
  let t: number;
  if (el.type === "ellipse") t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  else if (el.type === "diamond") t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else t = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity);
  const len = Math.hypot(dx, dy);
  return { x: c.x + dx * t + (dx / len) * gap, y: c.y + dy * t + (dy / len) * gap };
}

/** Caja real de un elemento (las flechas/líneas se miden por sus puntos). */
export function elementBox(el: El): Box {
  if (Array.isArray(el.points) && el.points.length) {
    const xs = el.points.map((p: number[]) => el.x + p[0]);
    const ys = el.points.map((p: number[]) => el.y + p[1]);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
  }
  return { x: Math.min(el.x, el.x + el.width), y: Math.min(el.y, el.y + el.height), width: Math.abs(el.width), height: Math.abs(el.height) };
}

function setArrowPoints(arrow: El, abs: Pt[]): void {
  if (abs.length < 2) abs = [abs[0] ?? { x: 0, y: 0 }, { x: (abs[0]?.x ?? 0) + 10, y: abs[0]?.y ?? 0 }];
  const first = abs[0];
  const last = abs[abs.length - 1];
  if (Math.hypot(last.x - first.x, last.y - first.y) < 1 && abs.length === 2) abs[1] = { x: first.x + 10, y: first.y };
  arrow.x = r2(first.x);
  arrow.y = r2(first.y);
  arrow.points = abs.map((p) => [r2(p.x - first.x), r2(p.y - first.y)]);
  const xs = arrow.points.map((p: number[]) => p[0]);
  const ys = arrow.points.map((p: number[]) => p[1]);
  arrow.width = r2(Math.max(...xs) - Math.min(...xs));
  arrow.height = r2(Math.max(...ys) - Math.min(...ys));
}

/** Punto donde Excalidraw dibuja el label de una flecha: punto medio o mitad del segmento central. */
function arrowLabelAnchor(arrow: El): Pt {
  const pts: number[][] = arrow.points;
  const n = pts.length;
  if (n % 2 === 1) {
    const p = pts[(n - 1) / 2];
    return { x: arrow.x + p[0], y: arrow.y + p[1] };
  }
  const a = pts[n / 2 - 1];
  const b = pts[n / 2];
  return { x: arrow.x + (a[0] + b[0]) / 2, y: arrow.y + (a[1] + b[1]) / 2 };
}

function centerTextIn(t: El, container: El): void {
  const c = container.type === "arrow" ? arrowLabelAnchor(container) : center(container);
  t.x = r2(c.x - t.width / 2);
  t.y = r2(c.y - t.height / 2);
}

/**
 * Recalcula los extremos de una flecha para que arranquen/terminen en el borde
 * de los elementos a los que está ligada. Conserva los puntos intermedios.
 * Las flechas "elbow" (codo) no se tocan: requieren el algoritmo de Excalidraw.
 */
function routeArrow(arrow: El, map: Map<string, El>, midShift: Pt = { x: 0, y: 0 }): void {
  if (arrow.elbowed) return;
  const startEl = arrow.startBinding ? map.get(arrow.startBinding.elementId) : undefined;
  const endEl = arrow.endBinding ? map.get(arrow.endBinding.elementId) : undefined;
  const abs: Pt[] = (arrow.points ?? [[0, 0]]).map((p: number[]) => ({ x: arrow.x + p[0], y: arrow.y + p[1] }));
  let mids = abs.slice(1, -1).map((p) => ({ x: p.x + midShift.x, y: p.y + midShift.y }));
  if (startEl && endEl && startEl.id === endEl.id && mids.length === 0) {
    // Auto-referencia: lazo por arriba a la derecha.
    mids = [
      { x: startEl.x + startEl.width * 0.7, y: startEl.y - 60 },
      { x: startEl.x + startEl.width + 60, y: startEl.y + startEl.height * 0.3 },
    ];
  }
  let start = abs[0];
  let end = abs[abs.length - 1] ?? start;
  if (startEl) start = borderPoint(startEl, mids[0] ?? (endEl ? center(endEl) : end), arrow.startBinding.gap ?? ARROW_GAP);
  if (endEl) end = borderPoint(endEl, mids[mids.length - 1] ?? (startEl ? center(startEl) : start), arrow.endBinding.gap ?? ARROW_GAP);
  setArrowPoints(arrow, [start, ...mids, end]);
  touch(arrow);
  const label = boundTextOf(arrow, map);
  if (label) {
    centerTextIn(label, arrow);
    touch(label);
  }
}

/**
 * Re-rutea las flechas conectadas a `el` después de moverlo `delta`. Los puntos
 * intermedios se trasladan: todo el delta en lazos (ambos extremos en `el`),
 * la mitad si el otro extremo quedó quieto, para que las curvas sigan al nodo.
 */
function rerouteAttached(el: El, map: Map<string, El>, delta: Pt = { x: 0, y: 0 }): void {
  for (const b of el.boundElements ?? []) {
    if (b.type !== "arrow") continue;
    const a = map.get(b.id);
    if (!a) continue;
    const s = a.startBinding?.elementId === el.id;
    const e = a.endBinding?.elementId === el.id;
    if (!s && !e) continue;
    const f = s && e ? 1 : 0.5;
    routeArrow(a, map, { x: delta.x * f, y: delta.y * f });
  }
}

// --- Construcción ---
export interface AppendResult {
  elements: El[];
  /** Clave del skeleton (id, o label si no tenía id, o "#<índice>") -> id del elemento creado. */
  nodeIds: Record<string, string>;
  edgeIds: string[];
}

export function buildScene(nodes: SkeletonNode[], edges: SkeletonEdge[] = [], opts: BuildOptions = {}): AppendResult {
  return appendToScene([], nodes, edges, opts);
}

/**
 * Agrega nodos y flechas a una escena existente (no muta el array recibido).
 * Los nodos sin x/y se distribuyen con layout por capas y el bloque se ubica sin
 * superponerse con lo existente. Las flechas pueden referenciar nodos del lote o
 * elementos ya existentes (por id, o por label exacto si es único).
 */
export function appendToScene(elements: El[], nodes: SkeletonNode[], edges: SkeletonEdge[] = [], opts: BuildOptions = {}): AppendResult {
  const dir: Direction = opts.direction ?? "LR";
  const out: El[] = structuredClone(elements);
  const map = liveMap(out);
  const allIds = new Set(out.map((e) => e.id));
  const nodeIds: Record<string, string> = {};
  const created: El[] = [];

  // 1. Crear nodos (todavía sin posición si no la tienen).
  const auto: El[] = [];
  const explicit: El[] = [];
  nodes.forEach((n, i) => {
    const type = n.type ?? "rectangle";
    if (!SHAPES.has(type) && type !== "text") throw new BuilderError(`Tipo de nodo inválido "${type}" (válidos: rectangle, ellipse, diamond, text).`);
    let id = n.id;
    if (id != null) {
      if (!ID_RE.test(id)) throw new BuilderError(`Id inválido "${id}": usá letras, números, "_", "-" o "." (máx 64).`);
      if (allIds.has(id)) throw new BuilderError(`Ya existe un elemento con id "${id}" en la escena.`);
    } else {
      do id = genId();
      while (allIds.has(id));
    }
    allIds.add(id);
    const label = n.label ?? "";
    let el: El;
    let text: El | null = null;
    if (type === "text") {
      if (!label) throw new BuilderError(`El nodo de tipo "text" ${n.id ?? `#${i}`} necesita label.`);
      el = makeText(label, NODE_FONT_SIZE, null, "left");
      el.id = id;
    } else {
      const m = label ? measureText(wrapLabel(label), NODE_FONT_SIZE) : { width: 0, height: 0 };
      const size = containerSizeFor(type, m.width, m.height);
      el = baseElement(type, 0, 0, n.width ?? size.width, n.height ?? size.height);
      el.id = id;
      el.roundness = type === "rectangle" ? { type: 3 } : type === "diamond" ? { type: 2 } : null;
      if (label) {
        text = makeText(label, NODE_FONT_SIZE, id, "center");
        el.boundElements = [{ type: "text", id: text.id }];
      }
    }
    if (n.backgroundColor) el.backgroundColor = n.backgroundColor;
    if (n.strokeColor) {
      el.strokeColor = n.strokeColor;
      if (text) text.strokeColor = n.strokeColor;
    }
    if (n.link != null) el.link = normalizeLink(n.link);
    if (n.customData && Object.keys(n.customData).length) el.customData = { ...n.customData };
    if (Number.isFinite(n.width)) el.width = Math.max(10, n.width!);
    if (Number.isFinite(n.height)) el.height = Math.max(10, n.height!);
    if (Number.isFinite(n.x) && Number.isFinite(n.y)) {
      el.x = r2(n.x!);
      el.y = r2(n.y!);
      explicit.push(el);
    } else auto.push(el);
    created.push(el);
    if (text) created.push(text);
    map.set(el.id, el);
    if (text) map.set(text.id, text);
    const key = n.id ?? (label && !(label in nodeIds) ? label : `#${i}`);
    nodeIds[key] = id;
  });

  // 2. Resolver extremos de flechas.
  const labelIndex = new Map<string, string[]>();
  for (const el of map.values()) {
    if (!BINDABLE.has(el.type) || (el.type === "text" && el.containerId)) continue;
    const lbl = (el.type === "text" ? el.originalText ?? el.text : boundTextOf(el, map)?.originalText ?? boundTextOf(el, map)?.text)?.trim().toLowerCase();
    if (lbl) labelIndex.set(lbl, [...(labelIndex.get(lbl) ?? []), el.id]);
  }
  const resolve = (ref: string, which: string, ei: number): El => {
    const direct = map.get(ref);
    if (direct) {
      if (direct.type === "text" && direct.containerId && map.get(direct.containerId)) return map.get(direct.containerId)!;
      if (!BINDABLE.has(direct.type)) throw new BuilderError(`Flecha #${ei}: "${ref}" es de tipo ${direct.type} y no se puede conectar.`);
      return direct;
    }
    const byLabel = labelIndex.get(String(ref).trim().toLowerCase());
    if (byLabel && byLabel.length === 1) return map.get(byLabel[0])!;
    const valid = [...map.values()].filter((e) => BINDABLE.has(e.type) && !(e.type === "text" && e.containerId)).map((e) => e.id);
    const hint = byLabel && byLabel.length > 1 ? ` (el label es ambiguo: ${byLabel.join(", ")})` : "";
    throw new BuilderError(`Flecha #${ei}: no existe el nodo ${which} "${ref}"${hint}. Ids válidos: ${valid.slice(0, 60).join(", ") || "(ninguno)"}.`);
  };
  const resolvedEdges = edges.map((e, i) => ({ e, from: resolve(e.from, "origen", i), to: resolve(e.to, "destino", i) }));

  // 3. Layout de los nodos sin posición.
  if (auto.length) {
    const autoIds = new Set(auto.map((a) => a.id));
    const lay = layeredLayout(
      auto.map((a) => ({ id: a.id, width: a.width, height: a.height })),
      resolvedEdges
        .filter((r) => autoIds.has(r.from.id) && autoIds.has(r.to.id))
        .map((r) => ({ from: r.from.id, to: r.to.id, ...(r.e.label ? edgeLabelSize(r.e.label) : {}) })),
      { direction: dir },
    );
    const existingBoxes = [...elements.filter(isLive), ...explicit].map(elementBox);
    const anchors: Box[] = [];
    for (const r of resolvedEdges) {
      if (autoIds.has(r.from.id) && !autoIds.has(r.to.id)) anchors.push(elementBox(r.to));
      if (autoIds.has(r.to.id) && !autoIds.has(r.from.id)) anchors.push(elementBox(r.from));
    }
    // Si hay flechas con label entre lo nuevo y lo existente, el hueco tiene que dejarlas ver.
    let gap = 150;
    for (const r of resolvedEdges) {
      if (!r.e.label || autoIds.has(r.from.id) === autoIds.has(r.to.id)) continue;
      const ls = edgeLabelSize(r.e.label);
      gap = Math.max(gap, (dir === "LR" ? ls.labelWidth : ls.labelHeight) + LABEL_CLEARANCE);
    }
    const { dx, dy } = placeBlock(lay, existingBoxes, anchors, dir, gap);
    for (const a of auto) {
      const p = lay.positions.get(a.id)!;
      a.x = r2(p.x + dx);
      a.y = r2(p.y + dy);
    }
  }
  for (const el of created) {
    if (el.type === "text" && el.containerId) centerTextIn(el, map.get(el.containerId)!);
  }

  // 4. Flechas.
  const pairCount = new Map<string, number>();
  for (const el of map.values()) {
    if (el.type === "arrow" && el.startBinding && el.endBinding) {
      const k = [el.startBinding.elementId, el.endBinding.elementId].sort().join("\u0000");
      pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
    }
  }
  const edgeIds: string[] = [];
  resolvedEdges.forEach(({ e, from, to }) => {
    const arrow = baseElement("arrow", 0, 0, 0, 0);
    while (allIds.has(arrow.id)) arrow.id = genId();
    allIds.add(arrow.id);
    Object.assign(arrow, {
      roundness: { type: 2 },
      strokeStyle: e.style ?? "solid",
      points: [[0, 0]],
      lastCommittedPoint: null,
      startBinding: { elementId: from.id, focus: 0, gap: ARROW_GAP },
      endBinding: { elementId: to.id, focus: 0, gap: ARROW_GAP },
      startArrowhead: e.bidirectional && e.arrowhead !== "none" ? "arrow" : null,
      endArrowhead: e.arrowhead === "none" ? null : "arrow",
      elbowed: false,
    });
    if (e.strokeColor) arrow.strokeColor = e.strokeColor;
    // Flechas paralelas entre el mismo par: se curvan con un punto intermedio desplazado.
    const sorted = [from.id, to.id].sort();
    const k = sorted.join("\u0000");
    const n = pairCount.get(k) ?? 0;
    pairCount.set(k, n + 1);
    const ca = center(from);
    const cb = center(to);
    if (from.id !== to.id) {
      if (n > 0) {
        const a = center(map.get(sorted[0])!);
        const b = center(map.get(sorted[1])!);
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const off = 40 * Math.ceil(n / 2) * (n % 2 ? 1 : -1);
        const mid = { x: (ca.x + cb.x) / 2 + (-(b.y - a.y) / len) * off, y: (ca.y + cb.y) / 2 + ((b.x - a.x) / len) * off };
        setArrowPoints(arrow, [ca, mid, cb]);
      } else setArrowPoints(arrow, [ca, cb]);
    }
    map.set(arrow.id, arrow);
    routeArrow(arrow, map);
    addBound(from, { id: arrow.id, type: "arrow" });
    if (to.id !== from.id) addBound(to, { id: arrow.id, type: "arrow" });
    created.push(arrow);
    if (e.label) {
      const t = makeText(e.label, EDGE_FONT_SIZE, arrow.id, "center", EDGE_WRAP_AT);
      while (allIds.has(t.id)) t.id = genId();
      allIds.add(t.id);
      if (e.strokeColor) t.strokeColor = e.strokeColor;
      arrow.boundElements = [{ type: "text", id: t.id }];
      centerTextIn(t, arrow);
      map.set(t.id, t);
      created.push(t);
    }
    edgeIds.push(arrow.id);
  });

  // Los nodos recién creados mantienen version 1 aunque se hayan "tocado" al armarlos.
  for (const el of created) {
    el.version = 1;
    el.updated = Date.now();
  }
  return { elements: [...out, ...created], nodeIds, edgeIds };
}

// --- Edición ---
export function updateElement(elements: El[], id: string, patch: ElementPatch): { elements: El[]; id: string } {
  const out: El[] = structuredClone(elements);
  const map = liveMap(out);
  let el = map.get(id);
  if (!el) throw new BuilderError(`No existe el elemento "${id}" (o está borrado).`);
  // Editar el texto de un label = editar su contenedor.
  if (el.type === "text" && el.containerId && map.get(el.containerId)) el = map.get(el.containerId)!;
  const isArrow = el.type === "arrow" || el.type === "line";
  const isFreeText = el.type === "text";

  if (isArrow && (patch.x != null || patch.y != null || patch.width != null || patch.height != null)) {
    throw new BuilderError("Las flechas no se mueven ni redimensionan directo: se re-rutean solas al mover sus nodos.");
  }
  if (!isArrow && patch.style != null) throw new BuilderError("`style` solo aplica a flechas.");

  let geometryChanged = false;
  let resized = false;
  const delta: Pt = { x: 0, y: 0 };
  if (patch.x != null || patch.y != null) {
    delta.x = (patch.x ?? el.x) - el.x;
    delta.y = (patch.y ?? el.y) - el.y;
    el.x = r2(el.x + delta.x);
    el.y = r2(el.y + delta.y);
    geometryChanged = true;
  }
  if (!isFreeText && (patch.width != null || patch.height != null)) {
    if (patch.width != null) el.width = Math.max(10, patch.width);
    if (patch.height != null) el.height = Math.max(10, patch.height);
    geometryChanged = true;
    resized = true;
  }
  if (patch.backgroundColor != null) el.backgroundColor = patch.backgroundColor;
  if (patch.strokeColor != null) {
    el.strokeColor = patch.strokeColor;
    const t = boundTextOf(el, map);
    if (t) {
      t.strokeColor = patch.strokeColor;
      touch(t);
    }
  }
  if (patch.style != null) el.strokeStyle = patch.style;
  if (patch.link !== undefined) el.link = normalizeLink(patch.link);
  if (patch.customData !== undefined) {
    if (patch.customData === null) delete el.customData;
    else {
      const next: Record<string, unknown> = { ...(el.customData ?? {}) };
      for (const [k, v] of Object.entries(patch.customData)) {
        if (v === null) delete next[k];
        else next[k] = v;
      }
      if (Object.keys(next).length) el.customData = next;
      else delete el.customData;
    }
  }

  let removedText: string | null = null;
  if (patch.label !== undefined) {
    if (isFreeText) {
      if (!patch.label) throw new BuilderError("Un texto suelto no puede quedar vacío: borralo con delete_elements.");
      setText(el, patch.label);
    } else {
      const t = boundTextOf(el, map);
      if (!patch.label) {
        if (t) {
          removeBound(el, t.id);
          removedText = t.id;
        }
      } else if (t) setText(t, patch.label, isArrow ? EDGE_WRAP_AT : WRAP_AT);
      else {
        const nt = makeText(patch.label, isArrow ? EDGE_FONT_SIZE : NODE_FONT_SIZE, el.id, "center", isArrow ? EDGE_WRAP_AT : WRAP_AT);
        nt.strokeColor = el.strokeColor;
        out.push(nt);
        map.set(nt.id, nt);
        addBound(el, { id: nt.id, type: "text" });
      }
      // Agrandar el contenedor si el label nuevo no entra (salvo que se haya fijado el tamaño).
      const bt = boundTextOf(el, map);
      if (bt && SHAPES.has(el.type) && patch.width == null && patch.height == null) {
        const need = containerSizeFor(el.type, bt.width, bt.height, false);
        if (need.width > el.width || need.height > el.height) {
          const c = center(el);
          el.width = Math.max(el.width, need.width);
          el.height = Math.max(el.height, need.height);
          el.x = r2(c.x - el.width / 2);
          el.y = r2(c.y - el.height / 2);
          geometryChanged = true;
          resized = true;
        }
      }
    }
  }
  touch(el);

  // El label se re-centra solo si cambió el texto o el tamaño; si solo se movió, se traslada
  // (respeta labels alineados a mano en la UI).
  const t = boundTextOf(el, map);
  if (t && !isArrow) {
    if (patch.label !== undefined || resized) {
      centerTextIn(t, el);
      touch(t);
    } else if (delta.x || delta.y) {
      t.x = r2(t.x + delta.x);
      t.y = r2(t.y + delta.y);
      touch(t);
    }
  } else if (t && isArrow && patch.label !== undefined) {
    centerTextIn(t, el);
    touch(t);
  }
  if (geometryChanged) rerouteAttached(el, map, delta);

  const final = removedText ? out.filter((e) => e.id !== removedText) : out;
  return { elements: final, id: el.id };
}

/**
 * Borra elementos (los saca del array). Al borrar un nodo se borran su label y
 * las flechas conectadas (con sus labels); se limpian las referencias en
 * boundElements, bindings y frameId de lo que queda.
 */
export function deleteElements(elements: El[], ids: string[]): { elements: El[]; removed: string[]; notFound: string[] } {
  const out: El[] = structuredClone(elements);
  const map = liveMap(out);
  const remove = new Set<string>();
  const notFound: string[] = [];
  const queue: string[] = [];
  for (const id of ids) {
    if (map.has(id)) queue.push(id);
    else notFound.push(id);
  }
  while (queue.length) {
    const id = queue.pop()!;
    if (remove.has(id)) continue;
    remove.add(id);
    const el = map.get(id);
    if (!el) continue;
    for (const b of el.boundElements ?? []) {
      const other = map.get(b.id);
      if (!other) continue;
      if (b.type === "text" && other.containerId === id) queue.push(b.id);
      // Flechas conectadas a un nodo borrado (no al revés: borrar una flecha no borra sus nodos).
      if (b.type === "arrow" && el.type !== "arrow" && (other.startBinding?.elementId === id || other.endBinding?.elementId === id)) queue.push(b.id);
    }
  }
  const kept = out.filter((e) => !remove.has(e.id));
  for (const e of kept) {
    if (Array.isArray(e.boundElements) && e.boundElements.some((b: any) => remove.has(b.id))) {
      const next = e.boundElements.filter((b: any) => !remove.has(b.id));
      e.boundElements = next.length ? next : null;
      touch(e);
    }
    if (e.startBinding && remove.has(e.startBinding.elementId)) {
      e.startBinding = null;
      touch(e);
    }
    if (e.endBinding && remove.has(e.endBinding.elementId)) {
      e.endBinding = null;
      touch(e);
    }
    if (e.containerId && remove.has(e.containerId)) {
      e.containerId = null;
      touch(e);
    }
    if (e.frameId && remove.has(e.frameId)) {
      e.frameId = null;
      touch(e);
    }
  }
  return { elements: kept, removed: [...remove], notFound };
}

// --- Resumen para agentes ---
export interface SceneSummary {
  nodes: {
    id: string;
    type: string;
    label?: string;
    x: number;
    y: number;
    w: number;
    h: number;
    link?: string;
    customData?: Record<string, unknown>;
  }[];
  edges: { id: string; from: string | null; to: string | null; label?: string; style?: string; bidirectional?: boolean; link?: string }[];
  texts: { id: string; text: string; x: number; y: number; link?: string }[];
  /** Otros elementos (líneas, trazos libres, flechas sin conectar...) solo contados por tipo. */
  other: Record<string, number>;
}

export function summarizeScene(elements: El[]): SceneSummary {
  const map = liveMap(elements);
  const s: SceneSummary = { nodes: [], edges: [], texts: [], other: {} };
  const rr = (n: number) => Math.round(n);
  for (const el of map.values()) {
    if (el.type === "text") {
      if (el.containerId && map.has(el.containerId)) continue; // label de otro elemento
      s.texts.push({ id: el.id, text: el.originalText ?? el.text, x: rr(el.x), y: rr(el.y), ...(el.link ? { link: el.link } : {}) });
    } else if (el.type === "arrow") {
      const label = boundTextOf(el, map);
      s.edges.push({
        id: el.id,
        from: el.startBinding?.elementId && map.has(el.startBinding.elementId) ? el.startBinding.elementId : null,
        to: el.endBinding?.elementId && map.has(el.endBinding.elementId) ? el.endBinding.elementId : null,
        ...(label ? { label: label.originalText ?? label.text } : {}),
        ...(el.strokeStyle && el.strokeStyle !== "solid" ? { style: el.strokeStyle } : {}),
        ...(el.startArrowhead && el.endArrowhead ? { bidirectional: true } : {}),
        ...(el.link ? { link: el.link } : {}),
      });
    } else if (BINDABLE.has(el.type)) {
      const label = boundTextOf(el, map);
      const name = el.type === "frame" || el.type === "magicframe" ? el.name : undefined;
      const text = label ? label.originalText ?? label.text : name;
      s.nodes.push({
        id: el.id,
        type: el.type,
        ...(text ? { label: text } : {}),
        x: rr(el.x),
        y: rr(el.y),
        w: rr(el.width),
        h: rr(el.height),
        ...(el.link ? { link: el.link } : {}),
        ...(el.customData && Object.keys(el.customData).length ? { customData: el.customData } : {}),
      });
    } else {
      s.other[el.type] = (s.other[el.type] ?? 0) + 1;
    }
  }
  return s;
}

export function sceneBounds(elements: El[]): Box | null {
  return boundingBox(elements.filter(isLive).map(elementBox));
}
