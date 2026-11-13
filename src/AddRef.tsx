import { useEffect, useId, useState } from "react";
import type { RefInfo } from "../shared/types.ts";
import { api, ApiError } from "./api.ts";

/** Campo para sumar a la vista una carpeta o un diagrama de cualquier repo, con autocompletado de rutas. */
export function AddRef({ onAdded, onCancel, compact }: { onAdded: (ref: RefInfo) => void; onCancel?: () => void; compact?: boolean }) {
  const [value, setValue] = useState("");
  const [items, setItems] = useState<string[]>([]);
  /** Para qué texto son las sugerencias que hay: si se tipea rápido pueden no haber llegado. */
  const [itemsFor, setItemsFor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const listId = useId();

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

  const submit = async () => {
    const path = value.trim();
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
      <input
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
      <datalist id={listId}>
        {items.map((i) => (
          <option key={i} value={i} />
        ))}
      </datalist>
      {error && <p className="add-ref-error">{error}</p>}
      <div className="add-ref-actions">
        <button className="btn primary" type="submit" disabled={busy}>
          Agregar
        </button>
        {onCancel && (
          <button className="btn ghost" type="button" onClick={onCancel}>
            Cancelar
          </button>
        )}
      </div>
      <p className="add-ref-hint">Una carpeta o un archivo .excalidraw de cualquier repo. Quitarlo de la vista no borra nada.</p>
    </form>
  );
}
