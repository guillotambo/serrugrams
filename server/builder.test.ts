import { test } from "node:test";
import assert from "node:assert/strict";
import { appendToScene, buildScene, deleteElements, summarizeScene, updateElement, elementBox, BuilderError, type El } from "./builder.ts";
import { layeredLayout, boxesOverlap } from "./layout.ts";

const BASE_FIELDS = [
  "id", "type", "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor", "fillStyle", "strokeWidth",
  "strokeStyle", "roughness", "opacity", "groupIds", "frameId", "index", "roundness", "seed", "version", "versionNonce",
  "isDeleted", "boundElements", "updated", "link", "locked",
];
const TEXT_FIELDS = ["fontSize", "fontFamily", "text", "originalText", "textAlign", "verticalAlign", "containerId", "lineHeight", "autoResize"];
const ARROW_FIELDS = ["points", "lastCommittedPoint", "startBinding", "endBinding", "startArrowhead", "endArrowhead", "elbowed"];

/** Invariantes estructurales que Excalidraw espera al cargar. */
function checkInvariants(elements: El[]) {
  const map = new Map(elements.map((e) => [e.id, e]));
  assert.equal(map.size, elements.length, "ids duplicados");
  for (const el of elements) {
    for (const f of BASE_FIELDS) assert.ok(f in el, `${el.type} ${el.id} sin campo ${f}`);
    for (const k of ["x", "y", "width", "height"]) assert.ok(Number.isFinite(el[k]), `${el.id}.${k} no es finito: ${el[k]}`);
    if (el.type === "text") {
      for (const f of TEXT_FIELDS) assert.ok(f in el, `texto ${el.id} sin ${f}`);
      assert.ok(el.text.length > 0);
      if (el.containerId) {
        const c = map.get(el.containerId);
        assert.ok(c, `contenedor ${el.containerId} no existe`);
        assert.ok(c.boundElements?.some((b: any) => b.id === el.id && b.type === "text"), `contenedor no lista el texto ${el.id}`);
      }
    }
    if (el.type === "arrow") {
      for (const f of ARROW_FIELDS) assert.ok(f in el, `flecha ${el.id} sin ${f}`);
      assert.deepEqual(el.points[0], [0, 0]);
      assert.ok(el.points.length >= 2);
      for (const p of el.points) assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]));
      for (const b of [el.startBinding, el.endBinding]) {
        if (!b) continue;
        assert.deepEqual(Object.keys(b).sort(), ["elementId", "focus", "gap"]);
        const t = map.get(b.elementId);
        assert.ok(t, `binding a ${b.elementId} inexistente`);
        assert.ok(t.boundElements?.some((x: any) => x.id === el.id && x.type === "arrow"), `${t.id} no lista la flecha ${el.id}`);
      }
    }
    for (const b of el.boundElements ?? []) {
      const o = map.get(b.id);
      assert.ok(o, `${el.id}.boundElements referencia ${b.id} inexistente`);
      if (b.type === "text") assert.equal(o.containerId, el.id);
      else assert.ok(o.startBinding?.elementId === el.id || o.endBinding?.elementId === el.id, `${o.id} no está ligada a ${el.id}`);
    }
  }
}

const nodesOf = (els: El[]) => els.filter((e) => ["rectangle", "ellipse", "diamond"].includes(e.type));

function assertNoOverlap(els: El[]) {
  const ns = nodesOf(els);
  for (let i = 0; i < ns.length; i++) {
    for (let j = i + 1; j < ns.length; j++) {
      assert.ok(!boxesOverlap(elementBox(ns[i]), elementBox(ns[j])), `se superponen ${ns[i].id} y ${ns[j].id}`);
    }
  }
}

const sample = () =>
  buildScene(
    [
      { id: "web", label: "Web app" },
      { id: "api", label: "API Gateway", customData: { service: "gateway", team: "core" } },
      { id: "pay", label: "Payments service", link: "pagos/detalle.excalidraw" },
      { id: "db", type: "ellipse", label: "Postgres" },
      { id: "q", type: "diamond", label: "Queue?" },
      { id: "note", type: "text", label: "Nota suelta" },
      { id: "lonely", label: "Sin conexiones" },
    ],
    [
      { from: "web", to: "api", label: "HTTPS" },
      { from: "api", to: "pay" },
      { from: "pay", to: "db", style: "dashed" },
      { from: "api", to: "q", arrowhead: "none" },
      { from: "q", to: "api" },
      { from: "db", to: "web", bidirectional: true }, // ciclo
      { from: "pay", to: "pay" }, // auto-referencia
    ],
  );

test("buildScene genera elementos válidos y bien ligados", () => {
  const { elements, nodeIds, edgeIds } = sample();
  checkInvariants(elements);
  assert.equal(nodeIds.api, "api");
  assert.equal(edgeIds.length, 7);
  const pay = elements.find((e) => e.id === "pay")!;
  assert.equal(pay.link, "/pagos/detalle.excalidraw");
  const db = elements.find((e) => e.id === "db")!;
  assert.equal(db.type, "ellipse");
  const label = elements.find((e) => e.containerId === "api")!;
  assert.equal(label.text, "API Gateway");
  assert.equal(label.fontFamily, 5);
});

test("auto layout sin superposiciones, con ciclos y nodos aislados, LR y TB", () => {
  for (const direction of ["LR", "TB"] as const) {
    const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, label: `Nodo ${i}` }));
    const edges = [
      { from: "n0", to: "n1" }, { from: "n1", to: "n2" }, { from: "n2", to: "n0" },
      { from: "n0", to: "n3" }, { from: "n3", to: "n4" }, { from: "n0", to: "n4" },
      { from: "n5", to: "n6" }, { from: "n7", to: "n6" }, { from: "n1", to: "n6" },
    ];
    const { elements } = buildScene(nodes, edges, { direction });
    checkInvariants(elements);
    assertNoOverlap(elements);
  }
});

/** Hueco libre entre dos cajas a lo largo del eje del layout (negativo si se superponen en ese eje). */
function axisGap(a: El, b: El, dir: "LR" | "TB"): number {
  const [p, s] = dir === "LR" ? ["x", "width"] : ["y", "height"];
  return Math.max(a[p], b[p]) - Math.min(a[p] + a[s], b[p] + b[s]);
}

function labeledEdges(els: El[]) {
  const byId = new Map(els.map((e) => [e.id, e]));
  return els
    .filter((e) => e.type === "text" && byId.get(e.containerId)?.type === "arrow")
    .map((t) => {
      const a = byId.get(t.containerId)!;
      return { t, a, from: byId.get(a.startBinding.elementId)!, to: byId.get(a.endBinding.elementId)! };
    });
}

function assertLabelClearance(els: El[], dir: "LR" | "TB") {
  const edges = labeledEdges(els);
  assert.ok(edges.length > 0);
  for (const { t, from, to } of edges) {
    const size = dir === "LR" ? t.width : t.height;
    const gap = axisGap(from, to, dir);
    assert.ok(gap >= size + 60, `${dir}: "${t.originalText}" mide ${size} pero el hueco ${from.id}->${to.id} es ${gap}`);
  }
}

test("los labels de flechas entre capas tienen lugar (LR y TB), también al agregar", () => {
  for (const direction of ["LR", "TB"] as const) {
    const { elements } = buildScene(
      [
        { id: "front", label: "Tienda web" }, { id: "checkout", label: "Checkout" }, { id: "pagos", label: "Pagos" },
        { id: "stock", label: "Stock" }, { id: "mail", label: "Notificaciones" }, { id: "kafka", type: "ellipse", label: "Kafka" },
      ],
      [
        { from: "front", to: "checkout", label: "POST /orders" },
        { from: "checkout", to: "pagos", label: "pago aprobado" },
        { from: "checkout", to: "stock", label: "reserva stock" },
        { from: "pagos", to: "kafka", label: "publica OrderPaid y otros eventos de dominio", style: "dashed" },
        { from: "kafka", to: "mail", label: "consume" },
        { from: "front", to: "mail" },
      ],
      { direction },
    );
    checkInvariants(elements);
    assertNoOverlap(elements);
    assertLabelClearance(elements, direction);
    // Labels de flechas paralelas (hermanos en la misma capa) no se pisan.
    const ls = labeledEdges(elements).map((x) => x.t);
    const p = ls.find((t) => t.originalText === "pago aprobado")!;
    const r = ls.find((t) => t.originalText === "reserva stock")!;
    assert.ok(!boxesOverlap(elementBox(p), elementBox(r)), `${direction}: labels paralelos superpuestos`);
    // Agregar un nodo conectado con label a lo existente también deja lugar.
    const more = appendToScene(elements, [{ id: "fraude", label: "Antifraude" }], [{ from: "pagos", to: "fraude", label: "consulta score de riesgo" }], { direction });
    checkInvariants(more.elements);
    assertNoOverlap(more.elements);
    const f = labeledEdges(more.elements).find((x) => x.to.id === "fraude")!;
    assert.ok(axisGap(f.from, f.to, direction) >= (direction === "LR" ? f.t.width : f.t.height) + 60);
    // Los labels de flecha no superan el ancho mínimo con el que Excalidraw re-envuelve (16 * 11).
    for (const t of ls) assert.ok(t.width <= 176, `label "${t.text}" demasiado ancho: ${t.width}`);
  }
});

test("layout LR avanza en x por capa y TB en y", () => {
  const nodes = ["a", "b", "c"].map((id) => ({ id, width: 100, height: 50 }));
  const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }];
  const lr = layeredLayout(nodes, edges, { direction: "LR" });
  assert.ok(lr.positions.get("a")!.x < lr.positions.get("b")!.x && lr.positions.get("b")!.x < lr.positions.get("c")!.x);
  const tb = layeredLayout(nodes, edges, { direction: "TB" });
  assert.ok(tb.positions.get("a")!.y < tb.positions.get("b")!.y && tb.positions.get("b")!.y < tb.positions.get("c")!.y);
  assert.equal(layeredLayout([], []).positions.size, 0);
});

test("las flechas arrancan y terminan en el borde, no en el centro", () => {
  const { elements } = buildScene([{ id: "a", label: "A", x: 0, y: 0, width: 200, height: 100 }, { id: "b", label: "B", x: 500, y: 0, width: 200, height: 100 }], [{ from: "a", to: "b" }]);
  const arrow = elements.find((e) => e.type === "arrow")!;
  assert.ok(Math.abs(arrow.x - 208) < 0.01, `start x ${arrow.x}`);
  assert.ok(Math.abs(arrow.y - 50) < 0.01);
  const endX = arrow.x + arrow.points[1][0];
  assert.ok(Math.abs(endX - 492) < 0.01, `end x ${endX}`);
});

test("nodos explícitos conservan su posición; los nuevos no se superponen con lo existente", () => {
  const first = buildScene([{ id: "a", label: "A", x: 100, y: 100 }, { id: "b", label: "B" }], [{ from: "a", to: "b" }]);
  const a = first.elements.find((e) => e.id === "a")!;
  assert.equal(a.x, 100);
  assert.equal(a.y, 100);
  assertNoOverlap(first.elements);
  const second = appendToScene(first.elements, [{ id: "c", label: "C" }, { id: "d", label: "D" }], [{ from: "b", to: "c" }, { from: "c", to: "d" }, { from: "D", to: "a" }]);
  checkInvariants(second.elements);
  assertNoOverlap(second.elements);
  assert.equal(second.elements.filter((e) => e.type === "arrow").length, 4);
  // No muta la entrada.
  assert.equal(first.elements.length, 5);
});

test("errores claros: id duplicado, extremo inexistente, link inválido", () => {
  const { elements } = sample();
  assert.throws(() => appendToScene(elements, [{ id: "api" }]), /Ya existe/);
  assert.throws(() => appendToScene(elements, [], [{ from: "api", to: "nope" }]), (e: any) => e instanceof BuilderError && /nope/.test(e.message) && /Ids válidos/.test(e.message));
  assert.throws(() => buildScene([{ label: "x", link: "no es link" }]), /Link inválido/);
});

test("updateElement: label, mover (re-rutea flechas y labels), colores, link, customData", () => {
  const { elements } = sample();
  const before = elements.find((e) => e.id === "api")!;
  const arrowsBefore = elements.filter((e) => e.type === "arrow" && (e.startBinding?.elementId === "api" || e.endBinding?.elementId === "api")).map((a) => structuredClone(a));
  let r = updateElement(elements, "api", { x: before.x + 300, y: before.y + 200, label: "API Gateway v2 con un nombre bastante largo", backgroundColor: "#a5d8ff", customData: { repo: "org/gw", team: null } }).elements;
  checkInvariants(r);
  const api = r.find((e) => e.id === "api")!;
  assert.equal(api.backgroundColor, "#a5d8ff");
  assert.deepEqual(api.customData, { service: "gateway", repo: "org/gw" });
  assert.ok(api.version > before.version);
  const text = r.find((e) => e.containerId === "api")!;
  assert.equal(text.originalText, "API Gateway v2 con un nombre bastante largo");
  assert.ok(text.width <= api.width && text.height <= api.height, "el contenedor creció para el label");
  // El label quedó centrado en el nodo.
  assert.ok(Math.abs(text.x + text.width / 2 - (api.x + api.width / 2)) < 1);
  for (const a0 of arrowsBefore) {
    const a1 = r.find((e) => e.id === a0.id)!;
    assert.ok(a1.x !== a0.x || a1.y !== a0.y || JSON.stringify(a1.points) !== JSON.stringify(a0.points), `flecha ${a0.id} no se re-ruteó`);
  }
  const httpsLabel = r.find((e) => e.type === "text" && e.originalText === "HTTPS")!;
  const httpsArrow = r.find((e) => e.id === httpsLabel.containerId)!;
  const mid = { x: httpsArrow.x + httpsArrow.points[1][0] / 2, y: httpsArrow.y + httpsArrow.points[1][1] / 2 };
  assert.ok(Math.abs(httpsLabel.x + httpsLabel.width / 2 - mid.x) < 1 && Math.abs(httpsLabel.y + httpsLabel.height / 2 - mid.y) < 1, "label de flecha centrado");

  r = updateElement(r, "api", { link: "/otro.excalidraw#abc" }).elements;
  assert.equal(r.find((e) => e.id === "api")!.link, "/otro.excalidraw#abc");
  r = updateElement(r, "api", { link: null, customData: null }).elements;
  assert.equal(r.find((e) => e.id === "api")!.link, null);
  assert.ok(!("customData" in r.find((e) => e.id === "api")!));

  // Quitar y volver a poner label.
  r = updateElement(r, "api", { label: "" }).elements;
  checkInvariants(r);
  assert.ok(!r.some((e) => e.containerId === "api"));
  r = updateElement(r, "api", { label: "Nuevo" }).elements;
  checkInvariants(r);
  assert.equal(r.find((e) => e.containerId === "api")!.text, "Nuevo");

  // Label en una flecha sin label, y estilo.
  const plain = r.find((e) => e.type === "arrow" && !e.boundElements)!;
  r = updateElement(r, plain.id, { label: "async", style: "dotted" }).elements;
  checkInvariants(r);
  assert.equal(r.find((e) => e.id === plain.id)!.strokeStyle, "dotted");
  assert.throws(() => updateElement(r, plain.id, { x: 5 }), /flechas/);
  assert.throws(() => updateElement(r, "zzz", { x: 5 }), /No existe/);
});

test("mover un nodo traslada los puntos intermedios de lazos y flechas curvas", () => {
  const { elements } = sample();
  const loop0 = elements.find((e) => e.type === "arrow" && e.startBinding?.elementId === "pay" && e.endBinding?.elementId === "pay")!;
  const curved0 = elements.find((e) => e.type === "arrow" && e.points.length === 3 && [e.startBinding?.elementId, e.endBinding?.elementId].includes("q"))!;
  assert.ok(loop0 && curved0);
  const abs = (a: El, i: number) => ({ x: a.x + a.points[i][0], y: a.y + a.points[i][1] });
  const pay = elements.find((e) => e.id === "pay")!;
  const q = elements.find((e) => e.id === "q")!;
  let r = updateElement(elements, "pay", { x: pay.x + 100, y: pay.y + 50 }).elements;
  r = updateElement(r, "q", { x: q.x - 60, y: q.y + 80 }).elements;
  checkInvariants(r);
  const loop1 = r.find((e) => e.id === loop0.id)!;
  for (const i of [1, 2]) {
    assert.ok(Math.abs(abs(loop1, i).x - abs(loop0, i).x - 100) < 0.05 && Math.abs(abs(loop1, i).y - abs(loop0, i).y - 50) < 0.05, `punto ${i} del lazo no siguió al nodo`);
  }
  // Los labels de flechas re-ruteadas siguen centrados en la flecha.
  for (const t of r.filter((e) => e.type === "text" && r.find((a) => a.id === e.containerId)?.type === "arrow")) {
    const a = r.find((x) => x.id === t.containerId)!;
    const n = a.points.length;
    const m = n % 2 ? abs(a, (n - 1) / 2) : { x: (abs(a, n / 2 - 1).x + abs(a, n / 2).x) / 2, y: (abs(a, n / 2 - 1).y + abs(a, n / 2).y) / 2 };
    assert.ok(Math.abs(t.x + t.width / 2 - m.x) < 0.05 && Math.abs(t.y + t.height / 2 - m.y) < 0.05, `label ${t.text} descentrado`);
  }
  const curved1 = r.find((e) => e.id === curved0.id)!;
  assert.ok(Math.abs(abs(curved1, 1).x - abs(curved0, 1).x - -30) < 0.05 && Math.abs(abs(curved1, 1).y - abs(curved0, 1).y - 40) < 0.05, "punto medio de la curva se trasladó medio delta");
});

test("un patch de link no toca nada más de elementos hechos en la UI", () => {
  const base = (id: string, type: string, extra: El = {}): El => ({
    id, type, x: 0, y: 0, width: 100, height: 40, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid",
    strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, index: "a0", roundness: null,
    seed: 1, version: 7, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false, ...extra,
  });
  const ui: El[] = [
    base("box", "rectangle", { boundElements: [{ id: "lbl", type: "text" }, { id: "arr", type: "arrow" }] }),
    base("lbl", "text", { x: 3, y: 2, width: 30, height: 25, text: "Hi", originalText: "Hi", fontSize: 20, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: "box", autoResize: true, lineHeight: 1.25 }),
    base("other", "ellipse", { x: 300, y: 0, boundElements: [{ id: "arr", type: "arrow" }] }),
    base("arr", "arrow", { x: 105, y: 20, width: 190, height: 0, points: [[0, 0], [190, 0]], lastCommittedPoint: null, startBinding: { elementId: "box", focus: 0.3, gap: 5 }, endBinding: { elementId: "other", focus: -0.2, gap: 5 }, startArrowhead: null, endArrowhead: "arrow", elbowed: false }),
  ];
  const r = updateElement(ui, "box", { link: "detalle.excalidraw" }).elements;
  const box = r.find((e) => e.id === "box")!;
  assert.equal(box.link, "/detalle.excalidraw");
  assert.deepEqual({ ...box, link: null, version: 7, versionNonce: 1, updated: 1 }, ui[0]);
  for (const id of ["lbl", "other", "arr"]) assert.deepEqual(r.find((e) => e.id === id), ui.find((e) => e.id === id), `${id} cambió`);
  // Cambiar el label de una caja chica no la infla al mínimo de creación.
  const r2 = updateElement(ui, "box", { label: "Ho" }).elements;
  assert.equal(r2.find((e) => e.id === "box")!.width, 100);
  assert.equal(r2.find((e) => e.id === "box")!.height, 40);
  // Mover traslada el label sin re-centrarlo.
  const r3 = updateElement(ui, "box", { x: 10 }).elements;
  assert.equal(r3.find((e) => e.id === "lbl")!.x, 13);
});

test("deleteElements limpia labels, flechas conectadas y referencias", () => {
  const { elements } = sample();
  const { elements: r, removed, notFound } = deleteElements(elements, ["api", "nope"]);
  checkInvariants(r);
  assert.deepEqual(notFound, ["nope"]);
  assert.ok(!r.some((e) => e.id === "api" || e.containerId === "api"));
  assert.ok(!r.some((e) => e.type === "arrow" && (e.startBinding?.elementId === "api" || e.endBinding?.elementId === "api")));
  assert.ok(removed.length > 3);
  // Borrar una flecha no borra sus nodos y los des-lista.
  const arrow = r.find((e) => e.type === "arrow" && e.startBinding?.elementId === "pay" && e.endBinding?.elementId === "db")!;
  const r2 = deleteElements(r, [arrow.id]).elements;
  checkInvariants(r2);
  assert.ok(r2.some((e) => e.id === "pay") && r2.some((e) => e.id === "db"));
  // Borrar un label deja el contenedor sin referencia.
  const lbl = r2.find((e) => e.containerId === "db")!;
  const r3 = deleteElements(r2, [lbl.id]).elements;
  checkInvariants(r3);
  assert.equal(r3.find((e) => e.id === "db")!.boundElements?.some((b: any) => b.type === "text") ?? false, false);
});

test("summarizeScene oculta la plomería de textos y tolera elementos de la UI", () => {
  const { elements } = sample();
  const extra: El[] = [
    { ...structuredClone(elements[0]), id: "tomb", isDeleted: true },
    { id: "ln", type: "line", x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [10, 10]], isDeleted: false },
    { id: "fd", type: "freedraw", x: 0, y: 0, width: 10, height: 10, points: [[0, 0]], isDeleted: false },
    { id: "loose", type: "arrow", x: 0, y: 0, width: 10, height: 0, points: [[0, 0], [10, 0]], startBinding: null, endBinding: null, isDeleted: false },
  ];
  const s = summarizeScene([...elements, ...extra]);
  assert.equal(s.nodes.length, 6);
  assert.equal(s.texts.length, 1);
  assert.equal(s.texts[0].text, "Nota suelta");
  assert.equal(s.edges.length, 8);
  const https = s.edges.find((e) => e.label === "HTTPS")!;
  assert.deepEqual([https.from, https.to], ["web", "api"]);
  assert.equal(s.edges.find((e) => e.id === "loose")!.from, null);
  assert.deepEqual(s.other, { line: 1, freedraw: 1 });
  assert.ok(!s.nodes.some((n) => n.id === "tomb"));
  assert.deepEqual(s.nodes.find((n) => n.id === "api")!.customData, { service: "gateway", team: "core" });
  // Editar/borrar con elementos ajenos presentes no rompe.
  assert.doesNotThrow(() => deleteElements([...elements, ...extra], ["web"]));
  assert.doesNotThrow(() => updateElement([...elements, ...extra], "web", { x: 1000 }));
});
