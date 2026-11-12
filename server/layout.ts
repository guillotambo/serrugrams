// Layout por capas (estilo Sugiyama) para nodos sin coordenadas. Sin dependencias.
//
// Pasos: componentes conexas -> romper ciclos (DFS) -> capas por camino más largo ->
// nodos ficticios para aristas largas -> orden por baricentro (varias pasadas) ->
// coordenadas (cada capa dimensionada por su nodo más grande, centrada en el eje cruzado).

export type Direction = "LR" | "TB";

export interface LayoutNode {
  id: string;
  width: number;
  height: number;
}

export interface LayoutEdge {
  from: string;
  to: string;
  /** Tamaño estimado del label de la flecha (si tiene): ensancha el hueco entre capas. */
  labelWidth?: number;
  labelHeight?: number;
}

/** Espacio libre mínimo a cada lado del label para que se vea la flecha (total, ambos lados). */
export const LABEL_CLEARANCE = 70;

export interface LayoutOptions {
  direction?: Direction;
  /** Separación entre capas (eje principal). */
  rankGap?: number;
  /** Separación entre nodos de una misma capa (eje cruzado). */
  nodeGap?: number;
  /** Separación entre componentes desconectadas. */
  componentGap?: number;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  /** Esquina superior izquierda de cada nodo. El bloque arranca en (0,0). */
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

const DUMMY_SIZE = 20;

/** Ubica todos los nodos; el resultado ocupa el rectángulo [0,width]x[0,height]. */
export function layeredLayout(nodes: LayoutNode[], edges: LayoutEdge[], opts: LayoutOptions = {}): LayoutResult {
  const dir = opts.direction ?? "LR";
  const rankGap = opts.rankGap ?? (dir === "LR" ? 120 : 100);
  const nodeGap = opts.nodeGap ?? (dir === "LR" ? 50 : 70);
  const componentGap = opts.componentGap ?? 100;

  const ids = new Set(nodes.map((n) => n.id));
  const cleanEdges = dedupeEdges(edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to));
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return { positions, width: 0, height: 0 };

  // Componentes conexas, en orden de aparición. Los nodos aislados se agrupan en una "componente" grilla.
  const comps = components(nodes, cleanEdges);
  const isolated = comps.filter((c) => c.length === 1).map((c) => c[0]);
  const connected = comps.filter((c) => c.length > 1);

  // En LR las componentes se apilan verticalmente; en TB, horizontalmente.
  let cursor = 0;
  let maxMain = 0;
  const placeBlock = (block: LayoutResult) => {
    for (const [id, p] of block.positions) {
      positions.set(id, dir === "LR" ? { x: p.x, y: p.y + cursor } : { x: p.x + cursor, y: p.y });
    }
    const crossSize = dir === "LR" ? block.height : block.width;
    const mainSize = dir === "LR" ? block.width : block.height;
    cursor += crossSize + componentGap;
    maxMain = Math.max(maxMain, mainSize);
  };

  for (const comp of connected) {
    const set = new Set(comp.map((n) => n.id));
    placeBlock(layoutComponent(comp, cleanEdges.filter((e) => set.has(e.from)), dir, rankGap, nodeGap));
  }
  if (isolated.length) placeBlock(gridLayout(isolated, dir, rankGap, nodeGap));

  let width = 0;
  let height = 0;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const [id, p] of positions) {
    const n = byId.get(id)!;
    width = Math.max(width, p.x + n.width);
    height = Math.max(height, p.y + n.height);
  }
  return { positions, width, height };
}

function dedupeEdges(edges: LayoutEdge[]): LayoutEdge[] {
  const seen = new Map<string, LayoutEdge>();
  const out: LayoutEdge[] = [];
  for (const e of edges) {
    const k = e.from + "\u0000" + e.to;
    const prev = seen.get(k);
    if (prev) {
      prev.labelWidth = Math.max(prev.labelWidth ?? 0, e.labelWidth ?? 0);
      prev.labelHeight = Math.max(prev.labelHeight ?? 0, e.labelHeight ?? 0);
      continue;
    }
    const copy = { ...e };
    seen.set(k, copy);
    out.push(copy);
  }
  return out;
}

function components(nodes: LayoutNode[], edges: LayoutEdge[]): LayoutNode[][] {
  const adj = new Map<string, string[]>();
  for (const n of nodes) adj.set(n.id, []);
  for (const e of edges) {
    adj.get(e.from)!.push(e.to);
    adj.get(e.to)!.push(e.from);
  }
  const seen = new Set<string>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: LayoutNode[][] = [];
  for (const n of nodes) {
    if (seen.has(n.id)) continue;
    const comp: LayoutNode[] = [];
    const stack = [n.id];
    seen.add(n.id);
    while (stack.length) {
      const id = stack.pop()!;
      comp.push(byId.get(id)!);
      for (const m of adj.get(id)!) {
        if (!seen.has(m)) {
          seen.add(m);
          stack.push(m);
        }
      }
    }
    // Mantener el orden original dentro de la componente.
    const order = new Map(nodes.map((x, i) => [x.id, i]));
    comp.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
    out.push(comp);
  }
  return out;
}

/** Nodos aislados: grilla aproximadamente cuadrada. */
function gridLayout(nodes: LayoutNode[], dir: Direction, rankGap: number, nodeGap: number): LayoutResult {
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const colW = Math.max(...nodes.map((n) => n.width));
  const rowH = Math.max(...nodes.map((n) => n.height));
  const positions = new Map<string, { x: number; y: number }>();
  const gx = dir === "LR" ? rankGap : nodeGap;
  const gy = dir === "LR" ? nodeGap : rankGap;
  nodes.forEach((n, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    positions.set(n.id, { x: c * (colW + gx) + (colW - n.width) / 2, y: r * (rowH + gy) + (rowH - n.height) / 2 });
  });
  const rows = Math.ceil(nodes.length / cols);
  return { positions, width: cols * colW + (cols - 1) * gx, height: rows * rowH + (rows - 1) * gy };
}

interface Vertex {
  id: string;
  w: number;
  h: number;
  dummy: boolean;
  layer: number;
}

function layoutComponent(nodes: LayoutNode[], edges: LayoutEdge[], dir: Direction, rankGap: number, nodeGap: number): LayoutResult {
  // 1. Romper ciclos: DFS y se invierten las aristas de retroceso.
  const out = new Map<string, string[]>();
  for (const n of nodes) out.set(n.id, []);
  for (const e of edges) out.get(e.from)!.push(e.to);
  const state = new Map<string, number>(); // 0 = sin visitar, 1 = en pila, 2 = terminado
  const back = new Set<string>();
  const visit = (start: string) => {
    // DFS iterativo para no reventar la pila con grafos grandes.
    const stack: { id: string; i: number }[] = [{ id: start, i: 0 }];
    state.set(start, 1);
    while (stack.length) {
      const top = stack[stack.length - 1];
      const succ = out.get(top.id)!;
      if (top.i < succ.length) {
        const m = succ[top.i++];
        const s = state.get(m) ?? 0;
        if (s === 1) back.add(top.id + "\u0000" + m);
        else if (s === 0) {
          state.set(m, 1);
          stack.push({ id: m, i: 0 });
        }
      } else {
        state.set(top.id, 2);
        stack.pop();
      }
    }
  };
  // Empezar por las fuentes (sin aristas entrantes) para que el flujo vaya en el sentido natural.
  const indeg = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  for (const e of edges) indeg.set(e.to, indeg.get(e.to)! + 1);
  for (const n of nodes) if (indeg.get(n.id) === 0 && !state.get(n.id)) visit(n.id);
  for (const n of nodes) if (!state.get(n.id)) visit(n.id);
  const dag = dedupeEdges(edges.map((e) => (back.has(e.from + "\u0000" + e.to) ? { ...e, from: e.to, to: e.from } : e)));

  // 2. Capas: camino más largo desde las fuentes (orden topológico de Kahn).
  const layer = new Map<string, number>();
  const inCount = new Map<string, number>(nodes.map((n) => [n.id, 0]));
  const succ = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of dag) {
    inCount.set(e.to, inCount.get(e.to)! + 1);
    succ.get(e.from)!.push(e.to);
  }
  const queue = nodes.filter((n) => inCount.get(n.id) === 0).map((n) => n.id);
  for (const id of queue) layer.set(id, 0);
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi];
    for (const m of succ.get(id)!) {
      layer.set(m, Math.max(layer.get(m) ?? 0, layer.get(id)! + 1));
      inCount.set(m, inCount.get(m)! - 1);
      if (inCount.get(m) === 0) queue.push(m);
    }
  }
  for (const n of nodes) if (!layer.has(n.id)) layer.set(n.id, 0); // defensa: no debería pasar

  // 3. Vértices y aristas entre capas consecutivas (con nodos ficticios para aristas largas).
  const verts = new Map<string, Vertex>();
  for (const n of nodes) verts.set(n.id, { id: n.id, w: n.width, h: n.height, dummy: false, layer: layer.get(n.id)! });
  const up = new Map<string, string[]>(); // predecesores en la capa anterior
  const down = new Map<string, string[]>(); // sucesores en la capa siguiente
  const link = (a: string, b: string) => {
    if (!down.has(a)) down.set(a, []);
    if (!up.has(b)) up.set(b, []);
    down.get(a)!.push(b);
    up.get(b)!.push(a);
  };
  let dummyCount = 0;
  for (const e of dag) {
    const la = layer.get(e.from)!;
    const lb = layer.get(e.to)!;
    let prev = e.from;
    for (let l = la + 1; l < lb; l++) {
      const id = `\u0000dummy${dummyCount++}`;
      verts.set(id, { id, w: DUMMY_SIZE, h: DUMMY_SIZE, dummy: true, layer: l });
      link(prev, id);
      prev = id;
    }
    link(prev, e.to);
  }

  const maxLayer = Math.max(...[...verts.values()].map((v) => v.layer));
  let layers: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  // Orden inicial: recorrido BFS desde las fuentes, que ya da pocos cruces en árboles.
  const placed = new Set<string>();
  const bfs = [...queue];
  for (let i = 0; i < bfs.length; i++) {
    const id = bfs[i];
    if (placed.has(id)) continue;
    placed.add(id);
    layers[verts.get(id)!.layer].push(id);
    for (const m of down.get(id) ?? []) if (!placed.has(m)) bfs.push(m);
  }
  for (const v of verts.values()) if (!placed.has(v.id)) layers[v.layer].push(v.id);

  // 4. Reducción de cruces: baricentro, alternando barridos hacia abajo y hacia arriba.
  let best = layers.map((l) => [...l]);
  let bestCross = countCrossings(best, down);
  for (let iter = 0; iter < 12 && bestCross > 0; iter++) {
    const downward = iter % 2 === 0;
    const pos = positionIndex(layers);
    const range = downward ? [...Array(layers.length).keys()].slice(1) : [...Array(layers.length).keys()].reverse().slice(1);
    for (const li of range) {
      const neighborsOf = downward ? up : down;
      const bary = new Map<string, number>();
      layers[li].forEach((id, i) => {
        const ns = neighborsOf.get(id) ?? [];
        bary.set(id, ns.length ? ns.reduce((s, n) => s + pos.get(n)!, 0) / ns.length : i);
      });
      layers[li] = [...layers[li]].sort((a, b) => bary.get(a)! - bary.get(b)!);
      layers[li].forEach((id, i) => pos.set(id, i));
    }
    const c = countCrossings(layers, down);
    if (c < bestCross) {
      bestCross = c;
      best = layers.map((l) => [...l]);
    }
  }
  layers = best;

  // 5. Coordenadas. Eje principal: capas; eje cruzado: nodos de la capa, centrados.
  const mainSize = (v: Vertex) => (dir === "LR" ? v.w : v.h);
  const crossSize = (v: Vertex) => (dir === "LR" ? v.h : v.w);
  // Hueco tras cada capa: al menos el label más largo (en el eje principal) de las flechas que lo cruzan
  // + LABEL_CLEARANCE, para que se vea la flecha a ambos lados del label.
  const gapAfter = layers.map(() => rankGap);
  let maxLabelCross = 0;
  for (const e of dag) {
    const lm = dir === "LR" ? e.labelWidth ?? 0 : e.labelHeight ?? 0;
    const lc = dir === "LR" ? e.labelHeight ?? 0 : e.labelWidth ?? 0;
    maxLabelCross = Math.max(maxLabelCross, lc);
    if (!lm) continue;
    const la = layer.get(e.from)!;
    const lb = layer.get(e.to)!;
    for (let l = Math.min(la, lb); l < Math.max(la, lb); l++) gapAfter[l] = Math.max(gapAfter[l], lm + LABEL_CLEARANCE);
  }
  // Separación entre hermanos: en un abanico (un nodo -> varios hermanos) los labels quedan a mitad
  // de camino, así que sus centros distan la MITAD de (tamaño-del-nodo + gap). Para que no se pisen:
  // (minCross + gap) / 2 >= label + margen.
  const minCross = Math.min(...nodes.map((n) => (dir === "LR" ? n.height : n.width)));
  if (maxLabelCross) nodeGap = Math.max(nodeGap, Math.ceil(2 * (maxLabelCross + 10) - minCross));
  const layerMain = layers.map((l) => Math.max(...l.map((id) => mainSize(verts.get(id)!))));
  const layerCross = layers.map((l) => l.reduce((s, id) => s + crossSize(verts.get(id)!), 0) + Math.max(0, l.length - 1) * nodeGap);
  const totalCross = Math.max(...layerCross);

  const positions = new Map<string, { x: number; y: number }>();
  let main = 0;
  layers.forEach((l, li) => {
    let cross = (totalCross - layerCross[li]) / 2;
    for (const id of l) {
      const v = verts.get(id)!;
      if (!v.dummy) {
        const m = main + (layerMain[li] - mainSize(v)) / 2;
        positions.set(id, dir === "LR" ? { x: m, y: cross } : { x: cross, y: m });
      }
      cross += crossSize(v) + nodeGap;
    }
    main += layerMain[li] + gapAfter[li];
  });
  const totalMain = main - gapAfter[layers.length - 1];
  return dir === "LR" ? { positions, width: totalMain, height: totalCross } : { positions, width: totalCross, height: totalMain };
}

function positionIndex(layers: string[][]): Map<string, number> {
  const pos = new Map<string, number>();
  for (const l of layers) l.forEach((id, i) => pos.set(id, i));
  return pos;
}

function countCrossings(layers: string[][], down: Map<string, string[]>): number {
  const pos = positionIndex(layers);
  let total = 0;
  for (let li = 0; li < layers.length - 1; li++) {
    const segs: [number, number][] = [];
    for (const id of layers[li]) for (const m of down.get(id) ?? []) segs.push([pos.get(id)!, pos.get(m)!]);
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const [a1, b1] = segs[i];
        const [a2, b2] = segs[j];
        if ((a1 - a2) * (b1 - b2) < 0) total++;
      }
    }
  }
  return total;
}

/** Caja que envuelve a todas las cajas, o null si no hay ninguna. */
export function boundingBox(boxes: Box[]): Box | null {
  if (boxes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function boxesOverlap(a: Box, b: Box, margin = 0): boolean {
  return a.x < b.x + b.width + margin && b.x < a.x + a.width + margin && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;
}

/**
 * Ubica un bloque de nodos nuevos (ya distribuido con `layeredLayout`) junto al
 * contenido existente sin superponerse: a la derecha (LR) o debajo (TB) de la
 * caja que envuelve todo, alineado en el eje cruzado con los nodos existentes a
 * los que se conecta (si hay). Devuelve el desplazamiento a sumar al bloque.
 */
export function placeBlock(
  block: { width: number; height: number },
  existing: Box[],
  anchors: Box[],
  dir: Direction,
  gap = 150,
): { dx: number; dy: number } {
  const bb = boundingBox(existing);
  if (!bb) return { dx: 0, dy: 0 };
  const anchorBox = boundingBox(anchors);
  if (dir === "LR") {
    const dx = bb.x + bb.width + gap;
    const dy = anchorBox ? anchorBox.y + anchorBox.height / 2 - block.height / 2 : bb.y;
    return { dx, dy };
  }
  const dy = bb.y + bb.height + gap;
  const dx = anchorBox ? anchorBox.x + anchorBox.width / 2 - block.width / 2 : bb.x;
  return { dx, dy };
}
