import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  hashElementsVersion,
  restoreElements,
  serializeAsJSON,
} from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { makeDiagramLink, parseDiagramLink, type ExcalidrawFile, type RelPath } from "../shared/types.ts";
import { api, ApiError } from "./api.ts";
import { bus, toast } from "./bus.ts";
import { displayName } from "./util.ts";

export type SaveStatus = "saved" | "saving" | "dirty" | "error";
export interface View {
  scrollX: number;
  scrollY: number;
  zoom: number;
}

/** Recuerda dónde estabas en cada diagrama para volver al mismo lugar. */
const viewMemory = new Map<RelPath, View>();

interface Props {
  path: RelPath;
  theme: "light" | "dark";
  focusElementId?: string;
  onNavigate: (path: RelPath, elementId?: string) => void;
  onReady: (api: ExcalidrawImperativeAPI | null) => void;
  onSelection: (ids: string[]) => void;
  onStatus: (s: SaveStatus) => void;
  onView: (v: View) => void;
  onSceneTick: () => void;
  onExport: () => void;
  onMissing: () => void;
  children?: ReactNode;
}

export function Editor(props: Props) {
  const { path, theme } = props;
  const [initial, setInitial] = useState<ExcalidrawFile | null>(null);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const cb = useRef(props);
  cb.current = props;

  const lastHash = useRef<string | undefined>(undefined);
  const lastVersion = useRef<string | null>(null);
  const lastSelection = useRef("");
  const dirty = useRef(false);
  const saving = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quietUntil = useRef(0);
  const alive = useRef(true);
  const latest = useRef<{ elements: readonly any[]; appState: any; files: any } | null>(null);
  const viewRef = useRef<View>({ scrollX: NaN, scrollY: NaN, zoom: NaN });

  // Carga inicial desde disco.
  useEffect(() => {
    alive.current = true;
    api
      .readFile(path)
      .then((res) => {
        if (!alive.current) return;
        lastHash.current = res.hash;
        setInitial(res.content);
      })
      .catch((err) => {
        if (!alive.current) return;
        toast(err instanceof ApiError ? err.message : "No se pudo abrir el diagrama", "error");
        cb.current.onMissing();
      });
    return () => {
      alive.current = false;
    };
  }, [path]);

  const versionOf = (elements: readonly any[], appState: any, files: any) =>
    `${hashElementsVersion(elements as any)}:${Object.keys(files ?? {}).length}:${appState.viewBackgroundColor}:${appState.gridModeEnabled ? 1 : 0}`;

  /** Trae el archivo de disco y lo aplica a la escena. Con `merge`, conserva lo local más nuevo. */
  const pullRemote = useCallback(
    async (merge: boolean) => {
      const ex = apiRef.current;
      if (!ex) return;
      const res = await api.readFile(path);
      if (!alive.current || res.hash === lastHash.current) return;
      lastHash.current = res.hash;
      let next = restoreElements(res.content.elements as any, null) as any[];
      if (merge) {
        const byId = new Map<string, any>(next.map((e) => [e.id, e]));
        for (const local of ex.getSceneElementsIncludingDeleted() as any[]) {
          const remote = byId.get(local.id);
          if (!remote || local.version > remote.version) byId.set(local.id, local);
        }
        next = [...byId.values()];
      } else {
        quietUntil.current = performance.now() + 400;
      }
      const files = Object.values(res.content.files ?? {}) as any[];
      if (files.length) ex.addFiles(files);
      ex.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER });
    },
    [path],
  );

  const save = useCallback(async () => {
    const ex = apiRef.current;
    if (!ex || saving.current) return;
    saving.current = true;
    dirty.current = false;
    cb.current.onStatus("saving");
    try {
      // Se guarda desde la última escena vista en onChange: al desmontar, la API puede estar ya vacía.
      const snap = latest.current;
      const content = snap
        ? JSON.parse(serializeAsJSON(snap.elements.filter((e: any) => !e.isDeleted), snap.appState, snap.files, "local"))
        : JSON.parse(serializeAsJSON(ex.getSceneElements(), ex.getAppState(), ex.getFiles(), "local"));
      content.source = "serrugrams";
      const { hash } = await api.saveFile(path, content, lastHash.current);
      lastHash.current = hash;
      cb.current.onStatus(dirty.current ? "dirty" : "saved");
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        // Alguien más (un agente, otro editor) escribió el archivo: combinamos y reintentamos.
        try {
          await pullRemote(true);
          dirty.current = true;
        } catch {
          cb.current.onStatus("error");
        }
      } else {
        dirty.current = true;
        cb.current.onStatus("error");
        saving.current = false;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(save, 3000);
        return;
      }
    }
    saving.current = false;
    if (dirty.current && alive.current) schedule(150);
  }, [path, pullRemote]);

  const schedule = useCallback(
    (ms = 500) => {
      dirty.current = true;
      cb.current.onStatus("dirty");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(save, ms);
    },
    [save],
  );

  // Cambios externos al archivo (MCP, git, otro editor).
  useEffect(
    () =>
      bus.on((e) => {
        if (e.type !== "file" || e.path !== path || e.hash === lastHash.current) return;
        pullRemote(dirty.current || saving.current).catch(() => {});
      }),
    [path, pullRemote],
  );

  // Al salir: guardar lo pendiente y recordar la vista.
  useEffect(() => {
    const flush = () => {
      if (timer.current) clearTimeout(timer.current);
      if (dirty.current) save();
    };
    window.addEventListener("beforeunload", flush);
    if (apiRef.current) cb.current.onReady(apiRef.current);
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
      const st = apiRef.current?.getAppState();
      if (st) viewMemory.set(path, { scrollX: st.scrollX, scrollY: st.scrollY, zoom: st.zoom.value });
      cb.current.onReady(null);
    };
  }, [save, path]);

  const handleApi = useCallback(
    (ex: ExcalidrawImperativeAPI) => {
      apiRef.current = ex;
      cb.current.onReady(ex);
      ex.onScrollChange((scrollX, scrollY, zoom) => {
        const v = { scrollX, scrollY, zoom: zoom.value };
        viewRef.current = v;
        viewMemory.set(path, v);
        cb.current.onView(v);
      });
      const st = ex.getAppState();
      cb.current.onView({ scrollX: st.scrollX, scrollY: st.scrollY, zoom: st.zoom.value });
    },
    [path],
  );

  // Enfocar un elemento cuando se llega por un link con #id.
  const focusKey = props.focusElementId; // "<elementId>#<n>": el sufijo fuerza re-enfocar
  const focusId = focusKey?.split("#")[0];
  const [apiReady, setReady] = useState(false);
  // Sin tamaño (pestaña o panel oculto al montar) el encuadre se calcula contra 0 px y queda
  // al zoom mínimo: se espera a que el editor mida algo.
  const [sized, setSized] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  const editorRef = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!node) return;
    // Medición directa primero: en una pestaña en segundo plano el observer no avisa hasta que se pinta.
    // Una vez que midió algo no vuelve a false: si no, al ocultarse y reaparecer re-enfocaría el link.
    const measure = () => {
      if (node.clientWidth <= 0 || node.clientHeight <= 0) return false;
      setSized(true);
      observer.current?.disconnect();
      return true;
    };
    if (measure()) return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(node);
  }, []);
  const ready = apiReady && sized;
  useEffect(() => {
    const ex = apiRef.current;
    if (!ready || !ex || !focusId) return;
    const id = setTimeout(() => {
      const el = ex.getSceneElements().find((e) => e.id === focusId);
      if (!el) return;
      const animate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      ex.updateScene({ appState: { selectedElementIds: { [focusId]: true } } as any, captureUpdate: CaptureUpdateAction.NEVER });
      ex.scrollToContent(el, { fitToViewport: true, viewportZoomFactor: 0.45, maxZoom: 1, animate, duration: 300 });
    }, 80);
    return () => clearTimeout(id);
  }, [ready, focusKey]);

  // Primera vez que se abre un diagrama: encuadrar todo el contenido sin agrandarlo de más.
  const fitted = useRef(false);
  // Se mira al montar: después, el propio Excalidraw ya anotó su vista inicial en viewMemory.
  const hadMemory = useRef(viewMemory.has(path));
  useEffect(() => {
    const ex = apiRef.current;
    if (!ready || !ex || fitted.current) return;
    fitted.current = true;
    if (focusKey || hadMemory.current) return;
    const id = setTimeout(() => {
      if (ex.getSceneElements().length) ex.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.85, maxZoom: 1, animate: false });
    }, 50);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  if (!initial) return <div className="editor-loading" />;

  const remembered = focusId ? undefined : viewMemory.get(path);
  return (
    <div className="editor" ref={editorRef}>
      <Excalidraw
        excalidrawAPI={(ex) => {
          handleApi(ex);
          setReady(true);
        }}
        initialData={{
          elements: initial.elements,
          appState: {
            ...initial.appState,
            ...(remembered ? { scrollX: remembered.scrollX, scrollY: remembered.scrollY, zoom: { value: remembered.zoom as any } } : {}),
          },
          files: initial.files,
          scrollToContent: !remembered,
        }}
        theme={theme}
        name={displayName(path)}
        langCode="es-ES"
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false, toggleTheme: false, saveAsImage: false } }}
        generateLinkForSelection={(id) => makeDiagramLink(path, id)}
        onLinkOpen={(element, event) => {
          const parsed = parseDiagramLink(element.link);
          if (!parsed) return;
          event.preventDefault();
          cb.current.onNavigate(parsed.path, parsed.elementId);
        }}
        onChange={(elements, appState, files) => {
          const sel = Object.keys(appState.selectedElementIds).filter((k) => appState.selectedElementIds[k]).join(",");
          if (sel !== lastSelection.current) {
            lastSelection.current = sel;
            cb.current.onSelection(sel ? sel.split(",") : []);
          }
          // onScrollChange no siempre avisa (p. ej. el centrado inicial): tomamos la vista también acá.
          const v = viewRef.current;
          if (v.scrollX !== appState.scrollX || v.scrollY !== appState.scrollY || v.zoom !== appState.zoom.value) {
            viewRef.current = { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value };
            cb.current.onView(viewRef.current);
          }
          cb.current.onSceneTick();
          latest.current = { elements, appState, files };
          const version = versionOf(elements, appState, files);
          if (lastVersion.current === null) {
            lastVersion.current = version;
            return;
          }
          if (version === lastVersion.current) return;
          lastVersion.current = version;
          if (performance.now() < quietUntil.current) return; // cambio que vino de disco, no hay que re-guardarlo
          schedule();
        }}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => cb.current.onExport()}>Exportar…</MainMenu.Item>
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
        {props.children}
      </Excalidraw>
    </div>
  );
}
