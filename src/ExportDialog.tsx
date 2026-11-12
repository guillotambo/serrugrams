import { useState } from "react";
import { convertToExcalidrawElements, exportToBlob, exportToSvg, getCommonBounds, serializeAsJSON } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { Comment, RelPath } from "../shared/types.ts";
import { toast } from "./bus.ts";
import { anchorPoint } from "./Comments.tsx";
import { displayName, downloadBlob, load, store } from "./util.ts";

type Format = "excalidraw" | "png" | "svg";

interface Props {
  path: RelPath;
  excalidraw: ExcalidrawImperativeAPI;
  comments: Comment[];
  theme: "light" | "dark";
  onClose: () => void;
}

/** Dibuja los comentarios como marcadores numerados más una leyenda al costado, para exportar como imagen. */
function commentElements(elements: readonly any[], comments: Comment[]): any[] {
  if (comments.length === 0) return [];
  const byId = new Map<string, any>(elements.map((e) => [e.id, e]));
  const skeleton: any[] = [];
  comments.forEach((c, i) => {
    const p = anchorPoint(c, byId);
    skeleton.push({
      type: "ellipse", x: p.x - 14, y: p.y - 14, width: 28, height: 28,
      backgroundColor: "#ffd43b", strokeColor: "#1e1e1e", fillStyle: "solid", strokeWidth: 1, roughness: 0,
      label: { text: String(i + 1), fontSize: 14, strokeColor: "#1e1e1e" },
    });
  });
  const [, minY, maxX] = elements.length ? getCommonBounds(elements as any) : [0, 0, 0, 0];
  const wrap = (text: string, width = 46) => {
    const out: string[] = [];
    for (const para of text.split("\n")) {
      let line = "";
      for (const word of para.split(" ")) {
        if ((line + " " + word).trim().length > width && line) (out.push(line), (line = word));
        else line = (line + " " + word).trim();
      }
      out.push(line);
    }
    return out.join("\n");
  };
  const lines = comments.map((c, i) => {
    const head = wrap(`${i + 1}. ${c.author || "Anónimo"}${c.resolved ? " (resuelto)" : ""}: ${c.text}`);
    const replies = c.replies.map((r) => wrap(`   ↳ ${r.author || "Anónimo"}: ${r.text}`));
    return [head, ...replies].join("\n");
  });
  skeleton.push({ type: "text", x: maxX + 80, y: minY, text: "Comentarios\n\n" + lines.join("\n\n"), fontSize: 16, strokeColor: "#1e1e1e" });
  return convertToExcalidrawElements(skeleton as any, { regenerateIds: true }) as any[];
}

export function ExportDialog({ path, excalidraw, comments, theme, onClose }: Props) {
  const [format, setFormat] = useState<Format>(() => load("export.format", "png"));
  const [withComments, setWithComments] = useState<boolean>(() => load("export.comments", false));
  const [includeResolved, setIncludeResolved] = useState(false);
  const [dark, setDark] = useState(theme === "dark");
  const [busy, setBusy] = useState(false);

  const selected = comments.filter((c) => includeResolved || !c.resolved);
  const name = displayName(path);

  const run = async () => {
    setBusy(true);
    store("export.format", format);
    store("export.comments", withComments);
    try {
      const elements = excalidraw.getSceneElements();
      const appState = excalidraw.getAppState();
      const files = excalidraw.getFiles();
      if (format === "excalidraw") {
        const data = JSON.parse(serializeAsJSON(elements, appState, files, "local"));
        // Los comentarios viajan en una clave propia; Excalidraw la ignora y Serrugrams la reconoce al importar.
        if (withComments && selected.length) data.serrugrams = { comments: selected };
        downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }), `${name}.excalidraw`);
      } else {
        const all = withComments ? [...elements, ...commentElements(elements, selected)] : [...elements];
        if (all.length === 0) {
          toast("El diagrama está vacío, no hay nada para exportar", "error");
          return;
        }
        const opts = {
          elements: all as any,
          files,
          appState: { ...appState, exportBackground: true, exportWithDarkMode: dark, exportEmbedScene: false },
          exportPadding: 24,
        };
        if (format === "png") {
          downloadBlob(await exportToBlob({ ...opts, mimeType: "image/png", getDimensions: (w: number, h: number) => ({ width: w * 2, height: h * 2, scale: 2 }) }), `${name}.png`);
        } else {
          const svg = await exportToSvg(opts);
          downloadBlob(new Blob([svg.outerHTML], { type: "image/svg+xml" }), `${name}.svg`);
        }
      }
      onClose();
    } catch (err) {
      console.error(err);
      toast("No se pudo exportar el diagrama", "error");
    } finally {
      setBusy(false);
    }
  };

  const formats: { id: Format; label: string; hint: string }[] = [
    { id: "png", label: "PNG", hint: "Imagen" },
    { id: "svg", label: "SVG", hint: "Vectorial" },
    { id: "excalidraw", label: ".excalidraw", hint: "Editable" },
  ];

  return (
    <div className="scrim" onMouseDown={onClose}>
      <div className="dialog" role="dialog" aria-label="Exportar diagrama" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <h2>Exportar "{name}"</h2>
        <div className="segmented" role="radiogroup" aria-label="Formato">
          {formats.map((f) => (
            <button key={f.id} role="radio" aria-checked={format === f.id} data-checked={format === f.id || undefined} onClick={() => setFormat(f.id)}>
              <strong>{f.label}</strong>
              <span>{f.hint}</span>
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={withComments} disabled={comments.length === 0} onChange={(e) => setWithComments(e.target.checked)} />
          <span>
            Incluir comentarios
            <small>
              {comments.length === 0
                ? "Este diagrama no tiene comentarios."
                : format === "excalidraw"
                  ? "Quedan guardados dentro del archivo. Quien lo abra en Serrugrams los ve; en excalidraw.com no aparecen."
                  : "Se dibujan como marcadores numerados con una leyenda al costado."}
            </small>
          </span>
        </label>
        {withComments && comments.some((c) => c.resolved) && (
          <label className="check sub">
            <input type="checkbox" checked={includeResolved} onChange={(e) => setIncludeResolved(e.target.checked)} />
            <span>Incluir también los resueltos</span>
          </label>
        )}
        {format !== "excalidraw" && (
          <label className="check">
            <input type="checkbox" checked={dark} onChange={(e) => setDark(e.target.checked)} />
            <span>Fondo oscuro</span>
          </label>
        )}
        <div className="dialog-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" autoFocus disabled={busy} onClick={run}>
            Exportar
          </button>
        </div>
      </div>
    </div>
  );
}
