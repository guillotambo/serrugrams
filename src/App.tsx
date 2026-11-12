import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureUpdateAction, newElementWith } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { DIAGRAM_EXT, makeDiagramLink, parseDiagramLink, type Comment, type RelPath, type TreeEntry } from "../shared/types.ts";
import { api, ApiError, subscribe } from "./api.ts";
import { bus, onToasts, toast, type Toast } from "./bus.ts";
import { CommentPins, CommentsPanel, anchorAt, anchorForElement, anchorPoint, useComments, type Draft } from "./Comments.tsx";
import { Editor, type SaveStatus } from "./Editor.tsx";
import { ExportDialog } from "./ExportDialog.tsx";
import { Icon } from "./icons.tsx";
import { Palette } from "./Palette.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { displayName, joinPath, load, sanitizeName, store } from "./util.ts";
import { useViewStore, viewStore } from "./viewStore.ts";

interface Loc {
  path: RelPath;
  focus?: string;
  /** Cambia en cada navegación para re-enfocar aunque el destino sea el mismo. */
  n: number;
}
interface Nav {
  current: Loc | null;
  back: Loc[];
  forward: Loc[];
}
let navCounter = 0;

const STATUS_LABEL: Record<SaveStatus, string> = { saved: "Guardado", saving: "Guardando…", dirty: "Sin guardar", error: "Error al guardar" };

export function App() {
  const [rootName, setRootName] = useState("");
  const [entries, setEntries] = useState<TreeEntry[] | null>(null);
  const [nav, setNav] = useState<Nav>({ current: null, back: [], forward: [] });
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [theme, setTheme] = useState<"light" | "dark">(() => load("theme", window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => load("sidebar", true));
  const [panelOpen, setPanelOpen] = useState<boolean>(() => load("panel", false));
  const [palette, setPalette] = useState<"open" | "link" | null>(null);
  const [exporting, setExporting] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [activeComment, setActiveComment] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [recent, setRecent] = useState<RelPath[]>(() => load("recent", []));
  const [createSignal, setCreateSignal] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Solo en desarrollo: acceso desde la consola para depurar.
    if (import.meta.env.DEV) (window as any).__serrugrams = { excalidraw };
  }, [excalidraw]);

  const current = nav.current?.path ?? null;
  const { comments, update: updateComments } = useComments(current);
  const entriesRef = useRef<TreeEntry[]>([]);
  entriesRef.current = entries ?? [];

  // --- Árbol y eventos en vivo ---
  const reloadTree = useCallback(() => {
    api
      .tree()
      .then((t) => {
        setRootName(t.rootName);
        setEntries(t.entries);
        document.title = `${t.rootName} · Serrugrams`;
      })
      .catch(() => toast("No se pudo leer la carpeta", "error"));
  }, []);
  useEffect(() => {
    reloadTree();
    return subscribe((e) => {
      if (e.type === "hello" || e.type === "tree") reloadTree();
      if (e.type !== "hello") bus.emit(e);
    });
  }, [reloadTree]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    store("theme", theme);
  }, [theme]);
  useEffect(() => store("sidebar", sidebarOpen), [sidebarOpen]);
  useEffect(() => store("panel", panelOpen), [panelOpen]);

  /** Registra un diagrama recién creado sin esperar al aviso del servidor. */
  const addKnown = useCallback((path: RelPath) => {
    if (entriesRef.current.some((e) => e.path === path)) return;
    entriesRef.current = [...entriesRef.current, { path, type: "file" }];
    setEntries(entriesRef.current);
  }, []);

  // --- Navegación ---
  const resetTransient = () => {
    setSelection([]);
    setDraft(null);
    setActiveComment(null);
    setPlacing(false);
    setStatus("saved");
  };
  const navigate = useCallback((path: RelPath, focus?: string) => {
    if (!entriesRef.current.some((e) => e.path === path && e.type === "file")) {
      toast(`"${displayName(path)}" no existe en esta carpeta`, "error");
      return;
    }
    setNav((n) => {
      const loc: Loc = { path, focus, n: ++navCounter };
      if (n.current?.path === path) return { ...n, current: loc };
      return { current: loc, back: n.current ? [...n.back, n.current].slice(-50) : n.back, forward: [] };
    });
  }, []);
  const goBack = useCallback((steps = 1) => {
    setNav((n) => {
      if (n.back.length < steps) return n;
      const target = n.back[n.back.length - steps];
      const skipped = n.back.slice(n.back.length - steps + 1);
      return { current: { ...target, focus: undefined, n: ++navCounter }, back: n.back.slice(0, n.back.length - steps), forward: [...(n.current ? [n.current] : []), ...skipped.reverse(), ...n.forward] };
    });
  }, []);
  const goForward = useCallback(() => {
    setNav((n) => {
      if (!n.forward.length) return n;
      const [target, ...rest] = n.forward;
      return { current: { ...target, focus: undefined, n: ++navCounter }, back: n.current ? [...n.back, n.current] : n.back, forward: rest };
    });
  }, []);

  useEffect(() => {
    resetTransient();
    if (!current) return;
    history.replaceState(null, "", "#/" + encodeURI(current));
    store("last", current);
    setRecent((r) => {
      const next = [current, ...r.filter((p) => p !== current)].slice(0, 20);
      store("recent", next);
      return next;
    });
  }, [current]);

  // Primera carga: abrir lo que diga la URL o el último diagrama.
  const booted = useRef(false);
  useEffect(() => {
    if (!entries || booted.current) return;
    booted.current = true;
    let fromHash = "";
    try {
      fromHash = decodeURI(location.hash.replace(/^#\//, ""));
    } catch {}
    const candidate = [fromHash, load<string>("last", "")].find((p) => p && entries.some((e) => e.path === p && e.type === "file"));
    if (candidate) navigate(candidate);
  }, [entries, navigate]);

  // Si el diagrama actual desaparece del disco, volver al estado vacío.
  useEffect(() => {
    if (entries && current && !entries.some((e) => e.path === current)) setNav((n) => ({ ...n, current: null }));
  }, [entries, current]);

  const mapPaths = (fn: (p: RelPath) => RelPath | null) =>
    setNav((n) => {
      const m = (l: Loc) => {
        const p = fn(l.path);
        return p === null ? null : { ...l, path: p };
      };
      const clean = (list: Loc[]) => list.map(m).filter((x): x is Loc => x !== null);
      return { current: n.current ? m(n.current) : null, back: clean(n.back), forward: clean(n.forward) };
    });
  const onRenamed = (from: RelPath, to: RelPath, isDir: boolean) =>
    mapPaths((p) => (p === from ? to : isDir && p.startsWith(from + "/") ? to + p.slice(from.length) : p));
  const onRemoved = (path: RelPath, isDir: boolean) => mapPaths((p) => (p === path || (isDir && p.startsWith(path + "/")) ? null : p));

  // --- Links entre diagramas ---
  const selectedElements = useMemo(() => {
    if (!excalidraw || selection.length === 0) return [];
    const ids = new Set(selection);
    return excalidraw.getSceneElements().filter((e) => ids.has(e.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excalidraw, selection, status]);
  const selectedLink = selectedElements.length === 1 ? parseDiagramLink(selectedElements[0].link) : null;

  const setLink = (link: string | null) => {
    if (!excalidraw) return;
    const ids = new Set(selection);
    excalidraw.updateScene({
      elements: excalidraw.getSceneElementsIncludingDeleted().map((el) => (ids.has(el.id) ? newElementWith(el, { link }) : el)),
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  };

  const onPalettePick = async (path: RelPath, created: boolean) => {
    const mode = palette;
    setPalette(null);
    try {
      if (created) {
        await api.createFile(path);
        addKnown(path);
      }
      if (mode === "link") {
        setLink(makeDiagramLink(path));
        toast(`Link a "${displayName(path)}" agregado. Hacé clic en el ícono de link del elemento para abrirlo.`);
      } else {
        navigate(path);
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "No se pudo completar la acción", "error");
    }
  };

  // --- Comentarios ---
  const startComment = () => {
    if (!excalidraw) return;
    setActiveComment(null);
    if (selectedElements.length === 1) {
      setDraft({ anchor: anchorForElement(selectedElements[0]) });
      return;
    }
    setDraft(null);
    setPlacing(true);
  };
  const placeAt = (e: React.MouseEvent) => {
    if (!excalidraw || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const { view } = viewStore.get();
    const x = (e.clientX - rect.left) / view.zoom - view.scrollX;
    const y = (e.clientY - rect.top) / view.zoom - view.scrollY;
    setPlacing(false);
    setDraft({ anchor: anchorAt(x, y, excalidraw.getSceneElements()) });
  };
  const pickComment = (c: Comment) => {
    if (!excalidraw || !canvasRef.current) return;
    const elements = new Map<string, any>(excalidraw.getSceneElements().map((e) => [e.id, e]));
    const p = anchorPoint(c, elements);
    const rect = canvasRef.current.getBoundingClientRect();
    const zoom = viewStore.get().view.zoom;
    excalidraw.updateScene({ appState: { scrollX: rect.width / 2 / zoom - p.x, scrollY: rect.height / 3 / zoom - p.y } as any, captureUpdate: CaptureUpdateAction.NEVER });
    setDraft(null);
    setActiveComment(c.id);
  };
  const openComments = comments.filter((c) => !c.resolved).length;

  // --- Importar archivos .excalidraw arrastrados ---
  const importFiles = async (files: FileList, dir: string) => {
    let last: RelPath | null = null;
    for (const file of Array.from(files)) {
      if (!file.name.endsWith(DIAGRAM_EXT)) {
        toast(`"${file.name}" no es un archivo ${DIAGRAM_EXT}`, "error");
        continue;
      }
      try {
        const data = JSON.parse(await file.text());
        const embedded = data.serrugrams?.comments;
        delete data.serrugrams;
        const stem = sanitizeName(file.name.slice(0, -DIAGRAM_EXT.length)) || "importado";
        let path = joinPath(dir, stem + DIAGRAM_EXT);
        for (let i = 2; entriesRef.current.some((e) => e.path === path); i++) path = joinPath(dir, `${stem} ${i}${DIAGRAM_EXT}`);
        await api.createFile(path, data, Array.isArray(embedded) ? { version: 1, comments: embedded } : undefined);
        addKnown(path);
        last = path;
      } catch {
        toast(`No se pudo importar "${file.name}"`, "error");
      }
    }
    if (last) {
      reloadTree();
      navigate(last);
    }
  };

  // --- Atajos de teclado ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        e.stopPropagation();
        setPalette("open");
      } else if ((e.altKey && e.key === "ArrowLeft") || (mod && e.key === "[")) {
        e.preventDefault();
        e.stopPropagation();
        goBack();
      } else if ((e.altKey && e.key === "ArrowRight") || (mod && e.key === "]")) {
        e.preventDefault();
        e.stopPropagation();
        goForward();
      } else if (mod && e.key === "\\") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (e.key === "Escape" && placing) {
        setPlacing(false);
      } else if (e.key === "Escape" && activeComment && !palette && !exporting) {
        setActiveComment(null);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [goBack, goForward, placing, activeComment, palette, exporting]);

  const trail = nav.back.slice(-3);
  const hiddenTrail = nav.back.length - trail.length;

  return (
    <div className="app" data-sidebar={sidebarOpen || undefined}>
      {sidebarOpen && (
        <Sidebar
          rootName={rootName}
          entries={entries ?? []}
          current={current}
          onOpen={(p) => navigate(p)}
          onCreated={(p) => {
            addKnown(p);
            navigate(p);
          }}
          onRenamed={onRenamed}
          onRemoved={onRemoved}
          onQuickOpen={() => setPalette("open")}
          onImport={importFiles}
          createSignal={createSignal}
        />
      )}
      <main className="main">
        <header className="topbar">
          <button className="icon-btn" title={sidebarOpen ? "Ocultar explorador (⌘\\)" : "Mostrar explorador (⌘\\)"} onClick={() => setSidebarOpen((v) => !v)}>
            <Icon.sidebar />
          </button>
          <button className="icon-btn" title="Volver (⌥←)" disabled={!nav.back.length} onClick={() => goBack()}>
            <Icon.back />
          </button>
          <button className="icon-btn" title="Adelante (⌥→)" disabled={!nav.forward.length} onClick={goForward}>
            <Icon.forward />
          </button>
          <div className="trail">
            {hiddenTrail > 0 && <span className="trail-sep">…</span>}
            {trail.map((loc, i) => (
              <span key={loc.n} className="trail-part">
                <button className="trail-item" title={`Volver a ${loc.path}`} onClick={() => goBack(trail.length - i)}>
                  {displayName(loc.path)}
                </button>
                <span className="trail-sep">›</span>
              </span>
            ))}
            {current && (
              <span className="trail-current" title={current}>
                {displayName(current)}
              </span>
            )}
          </div>
          {current && (
            <>
              <span className="status" data-status={status} aria-live="polite">
                {STATUS_LABEL[status]}
              </span>
              {selectedLink ? (
                <span className="chip">
                  <button className="chip-main" title={`Abrir ${selectedLink.path}`} onClick={() => navigate(selectedLink.path, selectedLink.elementId)}>
                    <Icon.arrowUpRight />
                    {displayName(selectedLink.path)}
                  </button>
                  <button className="chip-x" title="Cambiar destino" onClick={() => setPalette("link")}>
                    <Icon.link />
                  </button>
                  <button className="chip-x" title="Quitar link" onClick={() => setLink(null)}>
                    <Icon.close />
                  </button>
                </span>
              ) : (
                <button className="btn ghost" disabled={selection.length === 0} title={selection.length ? "Linkear lo seleccionado a otro diagrama" : "Seleccioná un elemento para linkearlo a otro diagrama"} onClick={() => setPalette("link")}>
                  <Icon.link />
                  Linkear
                </button>
              )}
              <button className="btn ghost" data-on={placing || undefined} title={selectedElements.length === 1 ? "Comentar el elemento seleccionado" : "Agregar un comentario: hacé clic en cualquier lugar del diagrama"} onClick={startComment}>
                <Icon.comment />
                Comentar
              </button>
              <button className="btn ghost" data-on={panelOpen || undefined} title="Ver comentarios" onClick={() => setPanelOpen((v) => !v)}>
                Comentarios
                {openComments > 0 && <span className="count">{openComments}</span>}
              </button>
              <button className="btn ghost" title="Exportar" onClick={() => setExporting(true)}>
                <Icon.export />
                Exportar
              </button>
            </>
          )}
          <button className="icon-btn" title={theme === "dark" ? "Tema claro" : "Tema oscuro"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            {theme === "dark" ? <Icon.sun /> : <Icon.moon />}
          </button>
        </header>
        <div className="canvas" ref={canvasRef}>
          {nav.current ? (
            <>
              <Editor
                key={nav.current.path}
                path={nav.current.path}
                theme={theme}
                focusElementId={nav.current.focus ? nav.current.focus + "#" + nav.current.n : undefined}
                onNavigate={navigate}
                onReady={setExcalidraw}
                onSelection={setSelection}
                onStatus={setStatus}
                onView={viewStore.setView}
                onSceneTick={viewStore.bump}
                onExport={() => setExporting(true)}
                onMissing={() => setNav((n) => ({ ...n, current: null }))}
              />
              <PinsLayer
                excalidraw={excalidraw}
                comments={comments}
                showResolved={showResolved}
                activeId={activeComment}
                draft={draft}
                onActive={setActiveComment}
                onDraft={setDraft}
                update={updateComments}
              />
              {placing && (
                <div className="placing" onClick={placeAt} onContextMenu={(e) => (e.preventDefault(), setPlacing(false))}>
                  <span className="placing-hint">Hacé clic donde quieras dejar el comentario · Esc para cancelar</span>
                </div>
              )}
            </>
          ) : (
            entries && (
              <div className="welcome">
                <h1>{entries.some((e) => e.type === "file") ? "Elegí un diagrama" : "Empezá tu primer diagrama"}</h1>
                <p>
                  Los diagramas se guardan como archivos <code>.excalidraw</code> en <strong>{rootName}</strong>. Podés linkear uno con otro para ir del panorama general al detalle.
                </p>
                <div className="welcome-actions">
                  <button
                    className="btn primary"
                    onClick={() => {
                      setSidebarOpen(true);
                      setCreateSignal((n) => n + 1);
                    }}
                  >
                    <Icon.plus />
                    Nuevo diagrama
                  </button>
                  {entries.some((e) => e.type === "file") && (
                    <button className="btn" onClick={() => setPalette("open")}>
                      <Icon.search />
                      Buscar <kbd>⌘P</kbd>
                    </button>
                  )}
                </div>
              </div>
            )
          )}
        </div>
      </main>
      {panelOpen && current && (
        <CommentsPanel
          comments={comments}
          showResolved={showResolved}
          activeId={activeComment}
          onShowResolved={setShowResolved}
          onPick={pickComment}
          onClose={() => setPanelOpen(false)}
          onAdd={startComment}
        />
      )}
      {palette && <Palette mode={palette} entries={entries ?? []} current={current} recent={recent} onPick={onPalettePick} onClose={() => setPalette(null)} />}
      {exporting && current && excalidraw && <ExportDialog path={current} excalidraw={excalidraw} comments={comments} theme={theme} onClose={() => setExporting(false)} />}
      <Toasts />
    </div>
  );
}

function PinsLayer(props: Omit<React.ComponentProps<typeof CommentPins>, "view" | "tick">) {
  const { view, tick } = useViewStore();
  return <CommentPins {...props} view={view} tick={tick} />;
}

function Toasts() {
  const [list, setList] = useState<Toast[]>([]);
  useEffect(() => onToasts(setList), []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className="toast" data-kind={t.kind}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
