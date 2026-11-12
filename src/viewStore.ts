import { useSyncExternalStore } from "react";
import type { View } from "./Editor.tsx";

// Vista del lienzo (scroll, zoom) y un contador de cambios de escena. Vive fuera de React
// para que mover el lienzo solo re-renderice la capa de pines y no toda la app.
let snapshot: { view: View; tick: number } = { view: { scrollX: 0, scrollY: 0, zoom: 1 }, tick: 0 };
const listeners = new Set<() => void>();
let frame = 0;
function notify() {
  listeners.forEach((l) => l());
}
export const viewStore = {
  get: () => snapshot,
  setView(view: View) {
    snapshot = { ...snapshot, view };
    notify();
  },
  bump() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      snapshot = { ...snapshot, tick: snapshot.tick + 1 };
      notify();
    });
  },
};
export function useViewStore() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => snapshot,
  );
}
