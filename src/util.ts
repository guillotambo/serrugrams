import { DIAGRAM_EXT, type RelPath } from "../shared/types.ts";

export const baseName = (p: RelPath) => p.split("/").pop() ?? p;
export const dirName = (p: RelPath) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const displayName = (p: RelPath) => {
  const b = baseName(p);
  return b.endsWith(DIAGRAM_EXT) ? b.slice(0, -DIAGRAM_EXT.length) : b;
};
export const joinPath = (dir: string, name: string) => (dir ? dir + "/" + name : name);

/** Limpia un nombre escrito por el usuario para usarlo como nombre de archivo o carpeta. */
export function sanitizeName(name: string): string {
  return name.replace(/[\\/:*?"<>|\0]/g, "-").replace(/^\.+/, "").trim();
}

export function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem("serrugrams." + key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
export function store(key: string, value: unknown) {
  try {
    localStorage.setItem("serrugrams." + key, JSON.stringify(value));
  } catch {}
}

/** Puntaje de coincidencia difusa; -1 si no coincide. Más alto es mejor. */
export function fuzzyScore(query: string, text: string): number {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 0;
  const idx = t.indexOf(q);
  if (idx >= 0) return 1000 - idx - (t.length - q.length) * 0.1;
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - ti);
    ti = found + 1;
  }
  return score;
}

export function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "recién";
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `hace ${Math.floor(s / 86400)} d`;
  return new Date(iso).toLocaleDateString("es-AR");
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
