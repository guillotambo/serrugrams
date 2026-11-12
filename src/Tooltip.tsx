import { useEffect, useLayoutEffect, useRef, useState } from "react";

interface Tip {
  text: string;
  keys?: string;
  rect: DOMRect;
  instant: boolean;
}

const DELAY = 500;
/** Si se pasa de un botón a otro dentro de este lapso, el siguiente aparece sin espera ni animación. */
const WARM = 400;

/**
 * Tooltips para todos los botones con `title`: un solo listener delegado.
 * El primero espera; los siguientes son instantáneos, así una barra de íconos se recorre rápido.
 */
export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; above: boolean } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let target: Element | null = null;
    let hiddenAt = 0;
    let shown = false;

    const hide = () => {
      clearTimeout(timer);
      if (shown) hiddenAt = performance.now();
      shown = false;
      target = null;
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.("button[title], button[data-tip]") ?? null;
      if (el === target) return;
      hide();
      if (!el) return;
      // El `title` nativo se reemplaza: tarda, no respeta el tema y duplicaría el tooltip.
      const title = el.getAttribute("title");
      if (title) {
        el.setAttribute("data-tip", title);
        if (!el.getAttribute("aria-label") && !el.textContent?.trim()) el.setAttribute("aria-label", title);
        el.removeAttribute("title");
      }
      const raw = el.getAttribute("data-tip");
      if (!raw) return;
      target = el;
      const m = raw.match(/^(.*?)\s*\(([⌘⌥⇧⌃][^()]*)\)$/);
      const instant = performance.now() - hiddenAt < WARM;
      const show = () => {
        if (!el.isConnected) return;
        shown = true;
        setTip({ text: m ? m[1] : raw, keys: m?.[2], rect: el.getBoundingClientRect(), instant });
      };
      if (instant) show();
      else timer = setTimeout(show, DELAY);
    };
    // Al hacer clic o teclear se oculta y no vuelve hasta salir del botón.
    const dismiss = () => {
      clearTimeout(timer);
      shown = false;
      hiddenAt = 0;
      setTip(null);
    };
    const out = (e: PointerEvent) => {
      if (target && !target.contains(e.relatedTarget as Node | null)) hide();
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", dismiss, true);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", dismiss, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!tip || !el) return setPos(null);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const above = tip.rect.bottom + 6 + h > window.innerHeight - 4;
    const left = Math.max(6, Math.min(window.innerWidth - w - 6, tip.rect.left + tip.rect.width / 2 - w / 2));
    setPos({ left: Math.round(left), top: Math.round(above ? tip.rect.top - 6 - h : tip.rect.bottom + 6), above });
  }, [tip]);

  if (!tip) return null;
  return (
    <div
      ref={ref}
      className="tooltip"
      role="tooltip"
      data-instant={tip.instant || undefined}
      data-above={pos?.above || undefined}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
    >
      {tip.text}
      {tip.keys && <kbd>{tip.keys}</kbd>}
    </div>
  );
}
