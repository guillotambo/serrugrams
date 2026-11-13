// Soltar carpetas o diagramas desde Finder para sumarlos a la vista. El navegador no da la ruta de lo soltado: se manda
// el nombre, el tamaño y la fecha (o el contenido de la carpeta) y el servidor lo busca en Spotlight (server/locate.ts).
// Si coincide más de un lugar, se hace elegir.
import { useEffect, useState } from "react";
import { DIAGRAM_EXT, type Dropped, type RefInfo } from "../shared/types.ts";
import { api, ApiError } from "./api.ts";
import { toast } from "./bus.ts";

/** Un arrastre que viene de afuera (Finder) y no de la barra lateral. */
export const isFinderDrag = (e: React.DragEvent) => e.dataTransfer.types.includes("Files") && !e.dataTransfer.types.includes("text/serrugrams-path");

/** Lee lo soltado. Hay que llamarla durante el evento `drop`: después el navegador vacía el DataTransfer. */
function readDropped(dt: DataTransfer): Promise<Dropped>[] {
  return Array.from(dt.items)
    .filter((it) => it.kind === "file")
    .map((it) => ({ entry: it.webkitGetAsEntry(), file: it.getAsFile() }))
    .map(async ({ entry, file }) => {
      if (entry?.isDirectory) {
        const children = await new Promise<string[]>((resolve) =>
          (entry as FileSystemDirectoryEntry).createReader().readEntries(
            (list) => resolve(list.map((e) => e.name)),
            () => resolve([]),
          ),
        );
        return { kind: "dir", name: entry.name, children } as const;
      }
      return { kind: "file", name: file?.name ?? entry?.name ?? "", size: file?.size ?? 0, mtime: file?.lastModified ?? 0 } as const;
    });
}

const tilde = (p: string, home: string) => (home && p.startsWith(home + "/") ? "~" + p.slice(home.length) : p);

/** Suma a la vista lo soltado desde Finder. Llama a `onAdded` por cada referencia nueva. */
export async function addDropped(dt: DataTransfer, onAdded: (ref: RefInfo) => void | Promise<void>) {
  for (const pending of readDropped(dt)) {
    const d = await pending;
    if (d.kind === "file" && !d.name.endsWith(DIAGRAM_EXT)) {
      toast(`"${d.name}" no es una carpeta ni un archivo ${DIAGRAM_EXT}`, "error");
      continue;
    }
    try {
      const { paths, home } = await api.locate(d);
      const path = paths.length > 1 ? await choosePath(d.name, paths, home) : paths[0];
      if (!path) {
        if (!paths.length) toast(`No encontré "${d.name}" en el disco. Probá con el botón de carpeta de «Agregar a la vista».`, "error");
        continue;
      }
      const { ref } = await api.addRef(path);
      await onAdded(ref);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : `No se pudo agregar "${d.name}"`, "error");
    }
  }
}

// --- Elegir entre varios lugares ---
type Choice = { name: string; paths: string[]; home: string; resolve: (p: string | null) => void };
let current: Choice | null = null;
const listeners = new Set<(c: Choice | null) => void>();
const set = (c: Choice | null) => {
  current = c;
  listeners.forEach((l) => l(c));
};

function choosePath(name: string, paths: string[], home: string): Promise<string | null> {
  current?.resolve(null);
  return new Promise((resolve) => set({ name, paths, home, resolve }));
}

/** Diálogo para elegir cuál de los lugares encontrados es el que se soltó. Va montado una vez, en App. */
export function PathChooser() {
  const [choice, setChoice] = useState<Choice | null>(current);
  useEffect(() => {
    listeners.add(setChoice);
    return () => void listeners.delete(setChoice);
  }, []);
  if (!choice) return null;
  const pick = (p: string | null) => {
    choice.resolve(p);
    set(null);
  };
  return (
    <div className="scrim" onMouseDown={() => pick(null)}>
      <div className="dialog" role="dialog" aria-label="Elegir cuál agregar" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && pick(null)}>
        <h2>¿Cuál "{choice.name}"?</h2>
        <p className="dialog-note">Hay más de un lugar con el mismo contenido. Elegí el que querés en la vista.</p>
        <div className="path-choices">
          {choice.paths.map((p, i) => (
            <button key={p} className="path-choice" autoFocus={i === 0} title={p} onClick={() => pick(p)}>
              {tilde(p, choice.home)}
            </button>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="btn ghost" onClick={() => pick(null)}>
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}
