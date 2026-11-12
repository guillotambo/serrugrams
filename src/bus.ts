import type { ServerEvent } from "../shared/types.ts";

type Handler = (e: ServerEvent) => void;
const handlers = new Set<Handler>();
export const bus = {
  on(h: Handler): () => void {
    handlers.add(h);
    return () => handlers.delete(h);
  },
  emit(e: ServerEvent) {
    for (const h of handlers) h(e);
  },
};

// --- Toasts ---
export interface Toast {
  id: number;
  text: string;
  kind: "info" | "error";
}
type ToastHandler = (toasts: Toast[]) => void;
let toasts: Toast[] = [];
let nextId = 1;
const toastHandlers = new Set<ToastHandler>();
export function toast(text: string, kind: Toast["kind"] = "info") {
  const t = { id: nextId++, text, kind };
  toasts = [...toasts.slice(-2), t];
  toastHandlers.forEach((h) => h(toasts));
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    toastHandlers.forEach((h) => h(toasts));
  }, kind === "error" ? 6000 : 3200);
}
export function onToasts(h: ToastHandler): () => void {
  toastHandlers.add(h);
  return () => toastHandlers.delete(h);
}
