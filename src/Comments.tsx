import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { Comment, CommentsFile, RelPath } from "../shared/types.ts";
import { api } from "./api.ts";
import { bus, toast } from "./bus.ts";
import { READ_ONLY } from "./mode.ts";
import { Icon } from "./icons.tsx";
import type { View } from "./Editor.tsx";
import { load, store, timeAgo, uid } from "./util.ts";

export interface Draft {
  anchor: Comment["anchor"];
}

/** Carga y guarda los comentarios del diagrama (archivo sidecar). */
export function useComments(path: RelPath | null) {
  const [comments, setComments] = useState<Comment[]>([]);
  const current = useRef<Comment[]>([]);
  current.current = comments;

  useEffect(() => {
    setComments([]);
    if (!path) return;
    let alive = true;
    const reload = () =>
      api
        .readComments(path)
        .then((f) => alive && setComments(f.comments))
        .catch(() => {});
    reload();
    const off = bus.on((e) => {
      if (e.type === "comments" && e.path === path) reload();
    });
    return () => {
      alive = false;
      off();
    };
  }, [path]);

  const update = useCallback(
    (fn: (list: Comment[]) => Comment[]) => {
      if (!path) return;
      const next = fn(current.current);
      setComments(next);
      const file: CommentsFile = { version: 1, comments: next };
      api.saveComments(path, file).catch(() => toast("No se pudieron guardar los comentarios", "error"));
    },
    [path],
  );

  return { comments, update };
}

export function getAuthor(): string {
  return load<string>("author", "");
}

/** Posición del comentario en coordenadas de escena: sigue al elemento si todavía existe. */
export function anchorPoint(c: { anchor: Comment["anchor"] }, elements: Map<string, any>): { x: number; y: number; orphan: boolean } {
  const el = c.anchor.elementId ? elements.get(c.anchor.elementId) : undefined;
  if (el && !el.isDeleted) return { x: el.x + (c.anchor.offset?.x ?? 0), y: el.y + (c.anchor.offset?.y ?? 0), orphan: false };
  return { x: c.anchor.x, y: c.anchor.y, orphan: !!c.anchor.elementId };
}

/** Ancla para un clic en la escena: se pega al elemento que esté debajo, si hay. */
export function anchorAt(x: number, y: number, elements: readonly any[]): Comment["anchor"] {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el.isDeleted || el.type === "frame") continue;
    const x1 = Math.min(el.x, el.x + el.width);
    const y1 = Math.min(el.y, el.y + el.height);
    if (x >= x1 && x <= x1 + Math.abs(el.width) && y >= y1 && y <= y1 + Math.abs(el.height)) {
      const target = el.containerId ? elements.find((e) => e.id === el.containerId) ?? el : el;
      return { elementId: target.id, offset: { x: x - target.x, y: y - target.y }, x, y };
    }
  }
  return { x, y };
}

export function anchorForElement(el: any): Comment["anchor"] {
  return { elementId: el.id, offset: { x: el.width, y: 0 }, x: el.x + el.width, y: el.y };
}

interface PinsProps {
  excalidraw: ExcalidrawImperativeAPI | null;
  comments: Comment[];
  view: View;
  tick: number;
  showResolved: boolean;
  activeId: string | null;
  draft: Draft | null;
  onActive: (id: string | null) => void;
  onDraft: (d: Draft | null) => void;
  update: (fn: (list: Comment[]) => Comment[]) => void;
}

export function CommentPins({ excalidraw, comments, view, tick, showResolved, activeId, draft, onActive, onDraft, update }: PinsProps) {
  void tick;
  // Tamaño del lienzo: decide de qué lado del pin entra el hilo sin cortarse.
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [!excalidraw]);
  if (!excalidraw) return null;
  const sideOf = (pos: { left: number; top: number }, height: number) => {
    const right = size.w - pos.left - THREAD_GAP - THREAD_W;
    const left = pos.left - 10 - THREAD_W;
    const below = size.h - pos.top + 30;
    const above = pos.top;
    return {
      "data-side": !size.w || right >= 8 || right >= left ? "right" : "left",
      "data-v": !size.h || below >= height + 8 || below >= above ? "down" : "up",
    } as const;
  };
  const elements = new Map<string, any>(excalidraw.getSceneElements().map((e) => [e.id, e]));
  const toScreen = (p: { x: number; y: number }) => ({ left: (p.x + view.scrollX) * view.zoom, top: (p.y + view.scrollY) * view.zoom });
  const visible = comments.filter((c) => showResolved || !c.resolved || c.id === activeId);
  const numbers = new Map(comments.map((c, i) => [c.id, i + 1]));

  return (
    <div className="pins" ref={box}>
      {visible.map((c) => {
        const pos = toScreen(anchorPoint(c, elements));
        const active = c.id === activeId;
        return (
          <div key={c.id} className="pin-wrap" style={{ transform: `translate(${pos.left}px, ${pos.top}px)`, zIndex: active ? 3 : 1 }}>
            <button
              className="pin"
              data-active={active || undefined}
              data-resolved={c.resolved || undefined}
              title={`${c.author}: ${c.text}`}
              onClick={() => {
                onDraft(null);
                onActive(active ? null : c.id);
              }}
            >
              <span>{numbers.get(c.id)}</span>
            </button>
            {active && <Thread comment={c} update={update} onClose={() => onActive(null)} side={sideOf(pos, 380)} />}
          </div>
        );
      })}
      {draft && (
        <div className="pin-wrap" style={{ transform: `translate(${toScreen(anchorPoint(draft, elements)).left}px, ${toScreen(anchorPoint(draft, elements)).top}px)`, zIndex: 4 }}>
          <div className="pin" data-active data-draft>
            <span>+</span>
          </div>
          <div className="thread popover" {...sideOf(toScreen(anchorPoint(draft, elements)), 170)}>
            <Composer
              placeholder="Escribí un comentario…"
              submitLabel="Comentar"
              askAuthor
              onCancel={() => onDraft(null)}
              onSubmit={(text, author) => {
                const id = uid();
                update((list) => [...list, { id, anchor: draft.anchor, author, createdAt: new Date().toISOString(), resolved: false, text, replies: [] }]);
                onDraft(null);
                onActive(null);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

const THREAD_W = 280;
const THREAD_GAP = 38;

function Thread({ comment, update, onClose, side }: { comment: Comment; update: PinsProps["update"]; onClose: () => void; side: Record<string, string> }) {
  const patch = (fn: (c: Comment) => Comment) => update((list) => list.map((c) => (c.id === comment.id ? fn(c) : c)));
  return (
    <div className="thread popover" {...side} onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="thread-head">
        <span className="thread-title">{comment.resolved ? "Resuelto" : "Comentario"}</span>
        {!READ_ONLY && (
          <>
            <button className="icon-btn" title={comment.resolved ? "Reabrir" : "Marcar como resuelto"} onClick={() => patch((c) => ({ ...c, resolved: !c.resolved }))}>
              <Icon.check />
            </button>
            <button
              className="icon-btn"
              title="Eliminar comentario"
              onClick={() => {
                update((list) => list.filter((c) => c.id !== comment.id));
                onClose();
              }}
            >
              <Icon.trash />
            </button>
          </>
        )}
        <button className="icon-btn" title="Cerrar" onClick={onClose}>
          <Icon.close />
        </button>
      </div>
      <div className="thread-body">
        <Message author={comment.author} at={comment.createdAt} text={comment.text} />
        {comment.replies.map((r) => (
          <Message key={r.id} author={r.author} at={r.createdAt} text={r.text} />
        ))}
      </div>
      {!READ_ONLY && (
        <Composer
          placeholder="Responder…"
          submitLabel="Responder"
          onSubmit={(text, author) => patch((c) => ({ ...c, replies: [...c.replies, { id: uid(), author, createdAt: new Date().toISOString(), text }] }))}
        />
      )}
    </div>
  );
}

function Message({ author, at, text }: { author: string; at: string; text: string }) {
  return (
    <div className="msg">
      <div className="msg-meta">
        <span className="avatar">{(author || "?").slice(0, 1).toUpperCase()}</span>
        <strong>{author || "Anónimo"}</strong>
        <time title={new Date(at).toLocaleString("es-AR")}>{timeAgo(at)}</time>
      </div>
      <p>{text}</p>
    </div>
  );
}

function Composer(props: { placeholder: string; submitLabel: string; askAuthor?: boolean; onSubmit: (text: string, author: string) => void; onCancel?: () => void }) {
  const [text, setText] = useState("");
  const [author, setAuthor] = useState(getAuthor);
  const needsAuthor = props.askAuthor && !getAuthor();
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (props.askAuthor) ref.current?.focus();
  }, [props.askAuthor]);
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    const a = author.trim() || "Anónimo";
    store("author", a);
    props.onSubmit(t, a);
    setText("");
  };
  return (
    <div className="composer">
      {needsAuthor && <input className="input" placeholder="Tu nombre" value={author} onChange={(e) => setAuthor(e.target.value)} />}
      <textarea
        ref={ref}
        className="input"
        rows={props.askAuthor ? 3 : 1}
        placeholder={props.placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") props.onCancel?.();
        }}
      />
      <div className="composer-actions">
        {props.onCancel && (
          <button className="btn ghost" onClick={props.onCancel}>
            Cancelar
          </button>
        )}
        <button className="btn primary" disabled={!text.trim()} onClick={submit}>
          {props.submitLabel}
        </button>
      </div>
    </div>
  );
}

interface PanelProps {
  comments: Comment[];
  showResolved: boolean;
  activeId: string | null;
  onShowResolved: (v: boolean) => void;
  onPick: (c: Comment) => void;
  onClose: () => void;
  onAdd: () => void;
}

export function CommentsPanel({ comments, showResolved, activeId, onShowResolved, onPick, onClose, onAdd }: PanelProps) {
  const list = comments.map((c, i) => ({ c, n: i + 1 })).filter(({ c }) => showResolved || !c.resolved);
  const resolvedCount = comments.filter((c) => c.resolved).length;
  return (
    <aside className="panel">
      <header className="panel-head">
        <h2>Comentarios</h2>
        {!READ_ONLY && (
          <button className="icon-btn" title="Nuevo comentario" onClick={onAdd}>
            <Icon.plus />
          </button>
        )}
        <button className="icon-btn" title="Cerrar panel" onClick={onClose}>
          <Icon.close />
        </button>
      </header>
      <div className="panel-list">
        {list.length === 0 && (
          <div className="empty-note">
            <p>No hay comentarios {comments.length ? "abiertos" : "todavía"}.</p>
            {!READ_ONLY && (
              <button className="btn" onClick={onAdd}>
                Agregar comentario
              </button>
            )}
          </div>
        )}
        {list.map(({ c, n }) => (
          <button key={c.id} className="panel-item" data-active={c.id === activeId || undefined} data-resolved={c.resolved || undefined} onClick={() => onPick(c)}>
            <span className="pin-mini">{n}</span>
            <span className="panel-item-body">
              <span className="panel-item-meta">
                <strong>{c.author || "Anónimo"}</strong>
                <time>{timeAgo(c.createdAt)}</time>
              </span>
              <span className="panel-item-text">{c.text}</span>
              {c.replies.length > 0 && <span className="panel-item-replies">{c.replies.length === 1 ? "1 respuesta" : `${c.replies.length} respuestas`}</span>}
            </span>
          </button>
        ))}
      </div>
      {resolvedCount > 0 && (
        <label className="panel-foot">
          <input type="checkbox" checked={showResolved} onChange={(e) => onShowResolved(e.target.checked)} />
          Mostrar resueltos ({resolvedCount})
        </label>
      )}
    </aside>
  );
}
