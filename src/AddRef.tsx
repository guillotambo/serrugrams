import { useEffect, useId, useRef, useState } from "react";
import type { RefInfo } from "../shared/types.ts";
import { api, ApiError } from "./api.ts";
import { Icon } from "./icons.tsx";

/** Si el servidor puede abrir el selector nativo (macOS). Se pregunta una vez por carga de página. */
let canPick: Promise<boolean> | null = null;

/**
 * Campo para sumar a la vista una carpeta o un diagrama de cualquier repo, con autocompletado de rutas y, donde se puede,
 * un botón que abre el selector de Finder (el navegador no da la ruta de un archivo; lo abre el servidor).
 */
export function AddRef({ onAdded, onCancel, compact }: { onAdded: (ref: RefInfo) => void; onCancel?: () => void; compact?: boolean }) {
  const [value, setValue] = useState("");
  const [items, setItems] = useState<string[]>([]);
  /** Para qué texto son las sugerencias que hay: si se tipea rápido pueden no haber llegado. */
  const [itemsFor, setItemsFor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState(false);
  const [picking, setPicking] = useState(false);
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    canPick ??= api.canPick().then((r) => r.available, () => false);
    let alive = true;
    canPick.then((ok) => alive && setPicker(ok));
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      api
        .complete(value)
        .then((r) => {
          if (!alive) return;
          setItems(r.items);
          setItemsFor(value);
        })
        .catch(() => {});
    }, 120);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [value]);

  const submit = async (picked?: string) => {
    const path = (picked ?? value).trim();
    if (!path) {
      setError("Escribí la ruta de una carpeta o de un diagrama");
      return;
    }
    setBusy(true);
    try {
      const { ref } = await api.addRef(path);
      onAdded(ref);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo agregar");
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    setPicking(true);
    setError("");
    try {
      const { path } = await api.pick(value);
      if (path) {
        setValue(path);
        await submit(path);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "No se pudo abrir el selector");
    } finally {
      setPicking(false);
      inputRef.current?.focus();
    }
  };

  // Tab completa hasta donde coinciden todas las sugerencias, como en la terminal.
  const commonPrefix = (list: string[]) => {
    if (!list.length) return "";
    let common = list[0];
    for (const it of list) while (!it.startsWith(common)) common = common.slice(0, -1);
    return common;
  };
  /** Devuelve true si se queda con el Tab (completa, o va a completar cuando lleguen las sugerencias). */
  const onTab = () => {
    if (!value) return false;
    if (itemsFor === value) {
      const common = commonPrefix(items);
      if (common.length <= value.length) return false;
      setValue(common);
      return true;
    }
    const typed = value;
    api
      .complete(typed)
      .then((r) => {
        const common = commonPrefix(r.items);
        setValue((v) => (v === typed && common.length > typed.length ? common : v));
      })
      .catch(() => {});
    return true;
  };

  return (
    <form
      className="add-ref"
      data-compact={compact || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="add-ref-field">
        <input
          ref={inputRef}
          className="input"
          autoFocus
          list={listId}
          value={value}
          placeholder="~/repos/mi-repo/docs/diagramas"
          spellCheck={false}
          aria-label="Ruta de una carpeta o de un diagrama"
          aria-invalid={!!error || undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setError("");
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") onCancel?.();
            if (e.key === "Tab" && !e.shiftKey && onTab()) e.preventDefault();
          }}
        />
        {picker && (
          <button className="icon-btn" type="button" title="Elegir en Finder" aria-label="Elegir en Finder" data-on={picking || undefined} disabled={busy} onClick={() => !picking && pick()}>
            <Icon.folder />
          </button>
        )}
      </div>
      <datalist id={listId}>
        {items.map((i) => (
          <option key={i} value={i} />
        ))}
      </datalist>
      {error && <p className="add-ref-error">{error}</p>}
      <div className="add-ref-actions">
        <button className="btn primary" type="submit" disabled={busy || picking}>
          Agregar
        </button>
        {onCancel && (
          <button className="btn ghost" type="button" onClick={onCancel}>
            Cancelar
          </button>
        )}
      </div>
      <p className="add-ref-hint">
        {picking
          ? "Elegí en la ventana de Finder que se abrió."
          : "Una carpeta o un archivo .excalidraw de cualquier repo. Quitarlo de la vista no borra nada."}
      </p>
    </form>
  );
}
