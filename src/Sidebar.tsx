import { useEffect, useMemo, useRef, useState } from "react";
import { DIAGRAM_EXT, type RelPath, type TreeEntry } from "../shared/types.ts";
import { api, ApiError } from "./api.ts";
import { toast } from "./bus.ts";
import { Icon } from "./icons.tsx";
import { baseName, dirName, displayName, joinPath, load, sanitizeName, store } from "./util.ts";

interface Node {
  name: string;
  path: RelPath;
  type: "file" | "dir";
  entry: TreeEntry;
  children: Node[];
}

function buildTree(entries: TreeEntry[]): Node[] {
  const root: Node[] = [];
  const dirs = new Map<string, Node>();
  for (const entry of entries) {
    const node: Node = { name: baseName(entry.path), path: entry.path, type: entry.type, entry, children: [] };
    if (entry.type === "dir") dirs.set(entry.path, node);
    const parent = dirs.get(dirName(entry.path));
    (parent ? parent.children : root).push(node);
  }
  const sort = (list: Node[]) => {
    list.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "es", { numeric: true }) : a.type === "dir" ? -1 : 1));
    list.forEach((n) => sort(n.children));
  };
  sort(root);
  return root;
}

type Editing = { mode: "rename"; path: RelPath; type: "file" | "dir" } | { mode: "new-file" | "new-dir"; dir: string };

interface Props {
  rootName: string;
  entries: TreeEntry[];
  current: RelPath | null;
  onOpen: (path: RelPath) => void;
  onCreated: (path: RelPath) => void;
  onRenamed: (from: RelPath, to: RelPath, isDir: boolean) => void;
  onRemoved: (path: RelPath, isDir: boolean) => void;
  onQuickOpen: () => void;
  onImport: (files: FileList, dir: string) => void;
  /** Pedido externo de crear un diagrama (desde el estado vacío). */
  createSignal: number;
}

export function Sidebar({ rootName, entries, current, onOpen, onCreated, onRenamed, onRemoved, onQuickOpen, onImport, createSignal }: Props) {
  const tree = useMemo(() => buildTree(entries), [entries]);
  const [collapsed, setCollapsed] = useState<string[]>(() => load("collapsed", []));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; node: Node | null } | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);

  const toggle = (path: string) => {
    const next = collapsed.includes(path) ? collapsed.filter((p) => p !== path) : [...collapsed, path];
    setCollapsed(next);
    store("collapsed", next);
  };
  const expand = (dir: string) => {
    if (!dir) return;
    const parts = dir.split("/");
    const all = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
    const next = collapsed.filter((p) => !all.includes(p));
    setCollapsed(next);
    store("collapsed", next);
  };

  const currentDir = current ? dirName(current) : "";
  const startNew = (mode: "new-file" | "new-dir", dir: string) => {
    expand(dir);
    setEditing({ mode, dir });
  };
  useEffect(() => {
    if (createSignal > 0) startNew("new-file", currentDir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createSignal]);

  // Si el diagrama actual queda dentro de una carpeta plegada, la abrimos.
  useEffect(() => {
    if (current) expand(dirName(current));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const commit = async (raw: string) => {
    const e = editing;
    setEditing(null);
    const name = sanitizeName(raw);
    if (!e || !name) return;
    try {
      if (e.mode === "new-file") {
        const path = joinPath(e.dir, name.endsWith(DIAGRAM_EXT) ? name : name + DIAGRAM_EXT);
        await api.createFile(path);
        onCreated(path);
      } else if (e.mode === "new-dir") {
        await api.mkdir(joinPath(e.dir, name));
      } else if (e.mode === "rename") {
        const to = joinPath(dirName(e.path), e.type === "file" && !name.endsWith(DIAGRAM_EXT) ? name + DIAGRAM_EXT : name);
        if (to === e.path) return;
        await api.rename(e.path, to);
        onRenamed(e.path, to, e.type === "dir");
      }
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "No se pudo completar la operación", "error");
    }
  };

  const remove = async (node: Node) => {
    try {
      await api.remove(node.path);
      onRemoved(node.path, node.type === "dir");
      toast(`"${displayName(node.path)}" se movió a la papelera (.serrugrams/trash)`);
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "No se pudo eliminar", "error");
    }
  };

  const move = async (from: RelPath, toDir: string) => {
    const to = joinPath(toDir, baseName(from));
    if (to === from || toDir === from || toDir.startsWith(from + "/")) return;
    try {
      await api.rename(from, to);
      onRenamed(from, to, !from.endsWith(DIAGRAM_EXT));
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "No se pudo mover", "error");
    }
  };

  const dropProps = (dir: string) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropDir(dir);
    },
    onDragLeave: () => setDropDir((d) => (d === dir ? null : d)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDropDir(null);
      if (e.dataTransfer.files.length) onImport(e.dataTransfer.files, dir);
      else {
        const from = e.dataTransfer.getData("text/serrugrams-path");
        if (from) move(from, dir);
      }
    },
  });

  const renderNodes = (nodes: Node[], depth: number, dir: string) => (
    <>
      {editing && editing.mode !== "rename" && editing.dir === dir && (
        <div className="row editing" style={{ paddingLeft: 8 + depth * 14 }}>
          <span className="row-icon">{editing.mode === "new-dir" ? <Icon.folder /> : <Icon.file />}</span>
          <NameInput initial="" placeholder={editing.mode === "new-dir" ? "Nombre de la carpeta" : "Nombre del diagrama"} onCommit={commit} />
        </div>
      )}
      {nodes.map((node) => {
        const isDir = node.type === "dir";
        const open = isDir && !collapsed.includes(node.path);
        const renaming = editing?.mode === "rename" && editing.path === node.path;
        return (
          <div key={node.path}>
            <div
              className="row"
              role="treeitem"
              tabIndex={0}
              aria-selected={node.path === current}
              data-active={node.path === current || undefined}
              data-drop={(isDir && dropDir === node.path) || undefined}
              style={{ paddingLeft: 8 + depth * 14 }}
              draggable={!renaming}
              onDragStart={(e) => e.dataTransfer.setData("text/serrugrams-path", node.path)}
              {...(isDir ? dropProps(node.path) : {})}
              onClick={() => (isDir ? toggle(node.path) : onOpen(node.path))}
              onKeyDown={(e) => {
                if (renaming) return;
                if (e.key === "Enter") isDir ? toggle(node.path) : onOpen(node.path);
                if (e.key === "F2") setEditing({ mode: "rename", path: node.path, type: node.type });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, node });
              }}
            >
              <span className="row-icon" data-open={open || undefined}>
                {isDir ? <Icon.chevron /> : <Icon.file />}
              </span>
              {renaming ? (
                <NameInput initial={isDir ? node.name : displayName(node.path)} onCommit={commit} />
              ) : (
                <span className="row-name" title={node.path}>
                  {isDir ? node.name : displayName(node.path)}
                </span>
              )}
              {!renaming && !!node.entry.openComments && (
                <span className="badge" title={node.entry.openComments === 1 ? "1 comentario abierto" : `${node.entry.openComments} comentarios abiertos`}>
                  {node.entry.openComments}
                </span>
              )}
              {!renaming && (
                <button
                  className="icon-btn row-more"
                  title="Más acciones"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu({ x: r.left, y: r.bottom + 4, node });
                  }}
                >
                  <Icon.more />
                </button>
              )}
            </div>
            {isDir && open && <div role="group">{renderNodes(node.children, depth + 1, node.path)}</div>}
          </div>
        );
      })}
    </>
  );

  const incoming = current ? entries.filter((e) => e.type === "file" && e.links?.includes(current)) : [];
  const outgoing = current ? entries.find((e) => e.path === current)?.links ?? [] : [];
  const known = new Set(entries.map((e) => e.path));

  return (
    <nav className="sidebar" {...dropProps("")} data-drop={dropDir === "" || undefined}>
      <header className="sidebar-head">
        <span className="brand" title={rootName}>
          {rootName}
        </span>
        <button className="icon-btn" title="Buscar diagrama (⌘P)" onClick={onQuickOpen}>
          <Icon.search />
        </button>
        <button className="icon-btn" title="Nuevo diagrama" onClick={() => startNew("new-file", currentDir)}>
          <Icon.plus />
        </button>
        <button className="icon-btn" title="Nueva carpeta" onClick={() => startNew("new-dir", currentDir)}>
          <Icon.folderPlus />
        </button>
      </header>
      <div
        className="tree"
        role="tree"
        onContextMenu={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY, node: null });
          }
        }}
      >
        {renderNodes(tree, 0, "")}
        {entries.length === 0 && !editing && (
          <div className="empty-note">
            <p>Esta carpeta todavía no tiene diagramas.</p>
            <button className="btn" onClick={() => startNew("new-file", "")}>
              Crear el primero
            </button>
          </div>
        )}
      </div>
      {current && (incoming.length > 0 || outgoing.length > 0) && (
        <section className="connections">
          {incoming.length > 0 && (
            <>
              <h3>Se llega desde</h3>
              {incoming.map((e) => (
                <button key={e.path} className="row" style={{ paddingLeft: 8 }} onClick={() => onOpen(e.path)}>
                  <span className="row-icon">
                    <Icon.back />
                  </span>
                  <span className="row-name">{displayName(e.path)}</span>
                </button>
              ))}
            </>
          )}
          {outgoing.length > 0 && (
            <>
              <h3>Lleva a</h3>
              {outgoing.map((p) => (
                <button key={p} className="row" style={{ paddingLeft: 8 }} data-missing={!known.has(p) || undefined} onClick={() => onOpen(p)} title={known.has(p) ? p : `${p} no existe`}>
                  <span className="row-icon">
                    <Icon.forward />
                  </span>
                  <span className="row-name">{displayName(p)}</span>
                </button>
              ))}
            </>
          )}
        </section>
      )}
      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {(() => {
            const node = menu.node;
            const dir = node ? (node.type === "dir" ? node.path : dirName(node.path)) : "";
            return (
              <>
                <MenuItem onSelect={() => startNew("new-file", dir)}>Nuevo diagrama</MenuItem>
                <MenuItem onSelect={() => startNew("new-dir", dir)}>Nueva carpeta</MenuItem>
                {node && (
                  <>
                    <hr />
                    <MenuItem onSelect={() => setEditing({ mode: "rename", path: node.path, type: node.type })}>Renombrar</MenuItem>
                    <MenuItem danger onSelect={() => remove(node)}>
                      Mover a la papelera
                    </MenuItem>
                  </>
                )}
              </>
            );
          })()}
        </Menu>
      )}
    </nav>
  );
}

function NameInput({ initial, placeholder, onCommit }: { initial: string; placeholder?: string; onCommit: (value: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = (value: string) => {
    if (done.current) return;
    done.current = true;
    onCommit(value);
  };
  return (
    <input
      ref={ref}
      className="name-input"
      defaultValue={initial}
      placeholder={placeholder}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onBlur={(e) => finish(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish("");
      }}
    />
  );
}

export function Menu({ x, y, onClose, children }: { x: number; y: number; onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ x: Math.min(x, window.innerWidth - r.width - 8), y: Math.min(y, window.innerHeight - r.height - 8) });
    }
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [x, y, onClose]);
  return (
    <div ref={ref} className="menu popover" role="menu" style={{ left: pos.x, top: pos.y }} onClick={onClose}>
      {children}
    </div>
  );
}

export function MenuItem({ children, onSelect, danger }: { children: React.ReactNode; onSelect: () => void; danger?: boolean }) {
  return (
    <button className="menu-item" role="menuitem" data-danger={danger || undefined} onClick={onSelect}>
      {children}
    </button>
  );
}
