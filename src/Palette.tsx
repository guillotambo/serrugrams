import { useEffect, useMemo, useRef, useState } from "react";
import { DIAGRAM_EXT, type RelPath, type TreeEntry } from "../shared/types.ts";
import { Icon } from "./icons.tsx";
import { READ_ONLY } from "./mode.ts";
import { dirName, displayName, fuzzyScore, joinPath, sanitizeName } from "./util.ts";

interface Props {
  mode: "open" | "link";
  entries: TreeEntry[];
  current: RelPath | null;
  /** Dónde se crea un diagrama nuevo si no hay uno abierto. */
  defaultDir: string;
  recent: RelPath[];
  onPick: (path: RelPath, created: boolean) => void;
  onClose: () => void;
}

/** Buscador rápido: abre un diagrama o elige el destino de un link. Sin animación: se usa todo el tiempo. */
export function Palette({ mode, entries, current, defaultDir, recent, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const files = entries.filter((e) => e.type === "file" && e.path !== current);
    const q = query.trim();
    const scored = files
      .map((e) => {
        const byName = fuzzyScore(q, displayName(e.path));
        const byPath = fuzzyScore(q, e.path);
        const recency = recent.indexOf(e.path);
        return { path: e.path, score: Math.max(byName >= 0 ? byName + 50 : -1, byPath) + (q ? 0 : recency >= 0 ? 100 - recency : 0) };
      })
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 50)
      .map((x) => ({ kind: "file" as const, path: x.path }));
    const name = sanitizeName(q);
    const dir = current ? dirName(current) : defaultDir;
    const newPath = name && dir ? joinPath(dir, name.endsWith(DIAGRAM_EXT) ? name : name + DIAGRAM_EXT) : "";
    const exists = entries.some((e) => e.path === newPath);
    return newPath && !exists && !READ_ONLY ? [...scored, { kind: "create" as const, path: newPath }] : scored;
  }, [entries, query, current, defaultDir, recent]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const pick = (i: number) => {
    const item = items[i];
    if (item) onPick(item.path, item.kind === "create");
  };

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-label={mode === "open" ? "Buscar diagrama" : "Linkear a un diagrama"} onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          {mode === "open" ? <Icon.search /> : <Icon.link />}
          <input
            autoFocus
            value={query}
            placeholder={mode === "open" ? "Buscar diagrama…" : "Linkear a… (elegí un diagrama o escribí un nombre nuevo)"}
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "ArrowDown") (e.preventDefault(), setIndex((i) => Math.min(items.length - 1, i + 1)));
              else if (e.key === "ArrowUp") (e.preventDefault(), setIndex((i) => Math.max(0, i - 1)));
              else if (e.key === "Enter") (e.preventDefault(), pick(index));
              else if (e.key === "Escape") onClose();
            }}
          />
        </div>
        <div className="palette-list" ref={listRef}>
          {items.length === 0 && <div className="palette-empty">{query ? "Sin resultados" : READ_ONLY ? "No hay otros diagramas." : "No hay otros diagramas todavía. Escribí un nombre para crear uno."}</div>}
          {items.map((item, i) => (
            <button key={item.kind + item.path} className="palette-item" data-selected={i === index} onMouseMove={() => setIndex(i)} onClick={() => pick(i)}>
              <span className="row-icon">{item.kind === "create" ? <Icon.plus /> : <Icon.file />}</span>
              <span className="palette-name">{item.kind === "create" ? `Crear "${displayName(item.path)}"${mode === "link" ? " y linkear" : ""}` : displayName(item.path)}</span>
              <span className="palette-path">{dirName(item.path)}</span>
            </button>
          ))}
        </div>
        <footer className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navegar</span>
          <span><kbd>↵</kbd> {mode === "open" ? "abrir" : "linkear"}</span>
          <span><kbd>esc</kbd> cerrar</span>
        </footer>
      </div>
    </div>
  );
}
