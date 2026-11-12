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
      const content = JSON.parse(serializeAsJSON(ex.getSceneElements(), ex.getAppState(), ex.getFiles(), "local"));
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
    return () => {
      window.removeEventListener("beforeunload", flush);
      flush();
      cb.current.onReady(null);
    };
  }, [save]);

  const handleApi = useCallback(
    (ex: ExcalidrawImperativeAPI) => {
      apiRef.current = ex;
      cb.current.onReady(ex);
      ex.onScrollChange((scrollX, scrollY, zoom) => {
        const v = { scrollX, scrollY, zoom: zoom.value };
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
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const ex = apiRef.current;
    if (!ready || !ex || !focusId) return;
    const el = ex.getSceneElements().find((e) => e.id === focusId);
    if (!el) return;
    ex.scrollToContent(el, { fitToViewport: true, viewportZoomFactor: 0.45, animate: true, duration: 300 });
    ex.updateScene({ appState: { selectedElementIds: { [focusId]: true } } as any, captureUpdate: CaptureUpdateAction.NEVER });
  }, [ready, focusKey]);

  if (!initial) return <div className="editor-loading" />;

  const remembered = focusId ? undefined : viewMemory.get(path);
  return (
    <div className="editor">
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
          cb.current.onSceneTick();
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
