import { useEffect, useRef, useState } from "react";

export const META_FIELDS = [
  { key: "service", label: "Servicio", placeholder: "payments-api" },
  { key: "repo", label: "Repo", placeholder: "org/payments-api" },
  { key: "team", label: "Equipo", placeholder: "Pagos" },
  { key: "docs", label: "Docs", placeholder: "https://…" },
] as const;

interface Props {
  elementId: string;
  data: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  onClose: () => void;
}

/** Datos del componente que representa un elemento (servicio, repo, equipo). Los agentes los leen por MCP. */
export function MetaPopover({ elementId, data, onChange, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(META_FIELDS.map((f) => [f.key, typeof data[f.key] === "string" ? (data[f.key] as string) : ""])));

  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    window.addEventListener("mousedown", down, true);
    return () => window.removeEventListener("mousedown", down, true);
  }, [onClose]);

  const set = (key: string, value: string) => {
    const next = { ...values, [key]: value };
    setValues(next);
    const merged: Record<string, unknown> = { ...data };
    for (const f of META_FIELDS) {
      const v = next[f.key].trim();
      if (v) merged[f.key] = v;
      else delete merged[f.key];
    }
    onChange(merged);
  };

  return (
    <div ref={ref} className="meta popover" role="dialog" aria-label="Datos del elemento" key={elementId}>
      <p className="meta-hint">Qué representa este elemento. Los agentes conectados por MCP pueden leer estos datos.</p>
      {META_FIELDS.map((f, i) => (
        <label key={f.key} className="meta-row">
          <span>{f.label}</span>
          <input
            className="input"
            autoFocus={i === 0}
            value={values[f.key]}
            placeholder={f.placeholder}
            spellCheck={false}
            onChange={(e) => set(f.key, e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape" || e.key === "Enter") onClose();
            }}
          />
        </label>
      ))}
    </div>
  );
}
