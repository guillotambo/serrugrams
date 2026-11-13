import { useEffect, useMemo, useRef, useState } from "react";
import { DIAGRAM_EXT, refIdOf, type RefInfo, type RelPath, type TreeEntry } from "../shared/types.ts";
import { AddRef } from "./AddRef.tsx";
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

type Editing =
  | { mode: "rename"; path: RelPath; type: "file" | "dir" }
  | { mode: "rename-ref"; id: string }
  | { mode: "new-file" | "new-dir"; dir: string };

interface Props {
  refs: RefInfo[];
  entries: TreeEntry[];
  current: RelPath | null;
  /** Carpeta donde se crea algo si no hay otra elegida: la primera carpeta de la vista. */
  defaultDir: string;
  onOpen: (path: RelPath) => void;
  onCreated: (path: RelPath) => void;
  onRenamed: (from: RelPath, to: RelPath, isDir: boolean) => void;
  onRemoved: (path: RelPath, isDir: boolean) => void;
  onQuickOpen: () => void;
  onImport: (files: FileList, dir: string) => void;
  onRefsChanged: () => Promise<void>;
  /** Pedido externo de crear un diagrama (desde el estado vacío). */
  createSignal: number;
}

export function Sidebar({ refs, entries, current, defaultDir, onOpen, onCreated, onRenamed, onRemoved, onQuickOpen, onImport, onRefsChanged, createSignal }: Props) {
  const visible = useMemo(() => entries.filter((e) => !e.hidden), [entries]);
  const tree = useMemo(() => buildTree(visible), [visible]);
  const visibleDirs = useMemo(() => new Set(visible.filter((e) => e.type === "dir").map((e) => e.path)), [visible]);
  // Raíz de cada referencia: la carpeta (su id) o el diagrama suelto.
  const refByPath = useMemo(() => new Map(refs.filter((r) => !r.missing).map((r) => [r.kind === "file" ? r.file! : r.id, r])), [refs]);
  const [collapsed, setCollapsed] = useState<string[]>(() => load("collapsed", []));
  const [editing, setEditing] = useState<Editing | null>(null);
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; node: Node | null; ref?: RefInfo } | null>(null);
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

  const currentDir = current ? dirName(current) : defaultDir;
  const startNew = (mode: "new-file" | "new-dir", dir: string) => {
    if (!dir) {
      toast("Primero agregá una carpeta a la vista");
      setAdding(true);
      return;
    }
    // Al lado de un diagrama suelto no se ven las carpetas: ahí solo se crean diagramas.
    if (mode === "new-dir" && !visibleDirs.has(dir)) {
      toast("Las carpetas nuevas van dentro de una carpeta de la vista", "error");
      return;
    }
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

  const fail = (err: unknown, fallback: string) => toast(err instanceof ApiError ? err.message : fallback, "error");

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
      } else if (e.mode === "rename-ref") {
        if (name === e.id) return;
        const { id } = await api.renameRef(e.id, name);
        onRenamed(e.id, id, true);
        onRefsChanged();
      } else if (e.mode === "rename") {
        const to = joinPath(dirName(e.path), e.type === "file" && !name.endsWith(DIAGRAM_EXT) ? name + DIAGRAM_EXT : name);
        if (to === e.path) return;
        await api.rename(e.path, to);
        onRenamed(e.path, to, e.type === "dir");
      }
    } catch (err) {
      fail(err, "No se pudo completar la operación");
    }
  };

  const remove = async (node: Node) => {
    try {
      await api.remove(node.path);
      onRemoved(node.path, node.type === "dir");
      toast(`"${displayName(node.path)}" se movió a la papelera (.serrugrams/trash)`);
    } catch (err) {
      fail(err, "No se pudo eliminar");
    }
  };

  const unref = async (ref: RefInfo) => {
    try {
      await api.removeRef(ref.id);
      onRemoved(ref.id, true);
      onRefsChanged();
      toast(`"${ref.id}" se quitó de la vista. No se borró nada.`);
    } catch (err) {
      fail(err, "No se pudo quitar");
    }
  };

  const move = async (from: RelPath, toDir: string) => {
    if (!toDir) return;
    const to = joinPath(toDir, baseName(from));
    if (to === from || toDir === from || toDir.startsWith(from + "/")) return;
    if (refIdOf(from) !== refIdOf(toDir)) {
      toast("No se puede mover entre referencias distintas: son repos o carpetas separadas", "error");
      return;
    }
    try {
      await api.rename(from, to);
      onRenamed(from, to, !from.endsWith(DIAGRAM_EXT));
    } catch (err) {
      fail(err, "No se pudo mover");
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
      if (e.dataTransfer.files.length) {
        const target = dir || defaultDir;
        if (target) onImport(e.dataTransfer.files, target);
        else toast("Primero agregá una carpeta a la vista", "error");
      } else {
        const from = e.dataTransfer.getData("text/serrugrams-path");
        if (from) move(from, dir);
      }
    },
  });

  const editingRow = (depth: number) =>
    editing &&
    (editing.mode === "new-file" || editing.mode === "new-dir") && (
      <div className="row editing" style={{ paddingLeft: 8 + depth * 14 }}>
        <span className="row-icon">{editing.mode === "new-dir" ? <Icon.folder /> : <Icon.file />}</span>
        <NameInput initial="" placeholder={editing.mode === "new-dir" ? "Nombre de la carpeta" : "Nombre del diagrama"} onCommit={commit} />
      </div>
    );

  const renderNodes = (nodes: Node[], depth: number, dir: string) => (
    <>
      {editing && editing.mode !== "rename" && editing.mode !== "rename-ref" && editing.dir === dir && editingRow(depth)}
      {nodes.map((node) => {
        const ref = depth === 0 ? refByPath.get(node.path) : undefined;
        const isDir = node.type === "dir";
        const open = isDir && !collapsed.includes(node.path);
        const renaming = (editing?.mode === "rename" && editing.path === node.path) || (editing?.mode === "rename-ref" && ref?.kind === "folder" && editing.id === ref.id);
        const label = ref?.kind === "folder" ? ref.id : isDir ? node.name : displayName(node.path);
        const looseDir = ref?.kind === "file" ? dirName(node.path) : null;
        return (
          <div key={node.path}>
            <div
              className={ref ? "row ref-row" : "row"}
              role="treeitem"
              tabIndex={0}
              aria-selected={node.path === current}
              data-active={node.path === current || undefined}
              data-drop={(isDir && dropDir === node.path) || undefined}
              style={{ paddingLeft: 8 + depth * 14 }}
              draggable={!renaming && !ref}
              onDragStart={(e) => e.dataTransfer.setData("text/serrugrams-path", node.path)}
              {...(isDir ? dropProps(node.path) : {})}
              onClick={() => (isDir ? toggle(node.path) : onOpen(node.path))}
              onKeyDown={(e) => {
                if (renaming) return;
                if (e.key === "Enter") isDir ? toggle(node.path) : onOpen(node.path);
                if (e.key === "F2") setEditing(ref?.kind === "folder" ? { mode: "rename-ref", id: ref.id } : { mode: "rename", path: node.path, type: node.type });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, node, ref });
              }}
            >
              <span className="row-icon" data-open={open || undefined}>
                {isDir ? <Icon.chevron /> : <Icon.file />}
              </span>
              {renaming ? (
                <NameInput initial={label} onCommit={commit} />
              ) : (
                <span className="row-name" title={ref ? ref.path : node.path}>
                  {label}
                </span>
              )}
              {!renaming && ref?.kind === "file" && <span className="row-dir">{baseName(ref.root)}</span>}
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
                    setMenu({ x: r.left, y: r.bottom + 4, node, ref });
                  }}
                >
                  <Icon.more />
                </button>
              )}
            </div>
            {isDir && open && <div role="group">{renderNodes(node.children, depth + 1, node.path)}</div>}
            {looseDir && editing?.mode === "new-file" && editing.dir === looseDir && editingRow(depth)}
          </div>
        );
      })}
    </>
  );

  // Las referencias, en el orden en que se agregaron.
  const rootNodes = tree.filter((n) => refByPath.has(n.path)).sort((a, b) => refs.indexOf(refByPath.get(a.path)!) - refs.indexOf(refByPath.get(b.path)!));
  const missing = refs.filter((r) => r.missing);

  const incoming = current ? entries.filter((e) => e.type === "file" && e.links?.includes(current)) : [];
  const outgoing = current ? entries.find((e) => e.path === current)?.links ?? [] : [];
  const known = new Set(entries.map((e) => e.path));

  return (
    <nav className="sidebar" {...dropProps("")} data-drop={dropDir === "" || undefined}>
      <header className="sidebar-head">
        <span className="brand">Serrugrams</span>
        <button className="icon-btn" title="Buscar diagrama (⌘P)" onClick={onQuickOpen}>
          <Icon.search />
        </button>
        <button className="icon-btn" data-on={adding || undefined} title="Agregar a la vista una carpeta o un diagrama" onClick={() => setAdding((v) => !v)}>
          <Icon.layersPlus />
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
        {adding && (
          <AddRef
            compact
            onAdded={async (ref) => {
              setAdding(false);
              toast(`"${ref.id}" está en la vista`);
              await onRefsChanged();
              if (ref.kind === "file" && ref.file) onOpen(ref.file);
            }}
            onCancel={() => setAdding(false)}
          />
        )}
        {renderNodes(rootNodes, 0, "")}
        {missing.map((ref) => (
          <div
            key={ref.id}
            className="row ref-row"
            data-missing
            style={{ paddingLeft: 8 }}
            title={`No se encuentra ${ref.path}`}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY, node: null, ref });
            }}
          >
            <span className="row-icon">{ref.kind === "folder" ? <Icon.folder /> : <Icon.file />}</span>
            <span className="row-name">{ref.id}</span>
            <button
              className="icon-btn row-more"
              title="Más acciones"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ x: r.left, y: r.bottom + 4, node: null, ref });
              }}
            >
              <Icon.more />
            </button>
          </div>
        ))}
        {refs.length === 0 && !adding && (
          <div className="empty-note">
            <p>Tu vista está vacía. Sumá carpetas o diagramas de cualquier repo; los archivos se quedan donde están.</p>
            <button className="btn" onClick={() => setAdding(true)}>
              Agregar a la vista
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
                  <span className="row-dir">{dirName(e.path)}</span>
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
                  <span className="row-dir">{dirName(p)}</span>
                </button>
              ))}
            </>
          )}
        </section>
      )}
      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {(() => {
            const { node, ref } = menu;
            if (ref?.missing) return <MenuItem onSelect={() => unref(ref)}>Quitar de la vista</MenuItem>;
            const dir = node ? (node.type === "dir" ? node.path : dirName(node.path)) : defaultDir;
            const canNewDir = visibleDirs.has(dir);
            return (
              <>
                {!node && <MenuItem onSelect={() => setAdding(true)}>Agregar a la vista…</MenuItem>}
                {dir && <MenuItem onSelect={() => startNew("new-file", dir)}>Nuevo diagrama</MenuItem>}
                {dir && canNewDir && <MenuItem onSelect={() => startNew("new-dir", dir)}>Nueva carpeta</MenuItem>}
                {node && (
                  <>
                    <hr />
                    <MenuItem onSelect={() => setEditing(ref?.kind === "folder" ? { mode: "rename-ref", id: ref.id } : { mode: "rename", path: node.path, type: node.type })}>
                      Renombrar
                    </MenuItem>
                    {ref && <MenuItem onSelect={() => unref(ref)}>Quitar de la vista</MenuItem>}
                    {ref?.kind !== "folder" && (
                      <MenuItem danger onSelect={() => remove(node)}>
                        Mover a la papelera
                      </MenuItem>
                    )}
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
