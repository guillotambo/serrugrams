#!/usr/bin/env node
// CLI de serrugrams: un solo servidor, de fondo, para todas las referencias de la vista (docs/referencias.md).
// El estado del servidor queda en ~/.serrugrams/server.json y su log en ~/.serrugrams/server.log.
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, renameSync, rmSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// En el repo clonado corre el TypeScript directo (siempre al día); el paquete npm no trae server/ y usa el compilado.
function serverScript(name) {
  const source = path.join(here, "..", "server", name + ".ts");
  return existsSync(source) ? source : path.join(here, "..", "dist", "server", name + ".js");
}

const HOME = process.env.SERRUGRAMS_HOME ? path.resolve(process.env.SERRUGRAMS_HOME) : path.join(os.homedir(), ".serrugrams");
const STATE = path.join(HOME, "server.json");
const LOG = path.join(HOME, "server.log");
const WORKSPACE = path.join(HOME, "workspace.json");
const DEFAULT_PORT = Number(process.env.SERRUGRAMS_PORT ?? 4747);
const COMMANDS = new Set(["ls", "list", "remove", "rm", "stop", "open", "logs", "help", "mcp"]);

const HELP = `serrugrams: diagramas de sistemas sobre Excalidraw.

Un solo servidor muestra tu vista: las carpetas y diagramas que elegiste, de cualquier repo.
Los archivos se quedan en cada repo; la vista se arma desde la interfaz (o desde acá).

Uso:
  serrugrams                      Levanta el servidor de fondo (si no está) y abre el navegador.
  serrugrams <ruta>…              Lo mismo, y suma esas carpetas o diagramas a la vista.
  serrugrams ls                   Estado del servidor y lo que hay en la vista.
  serrugrams remove <nombre|ruta> Quita algo de la vista (no borra nada del disco).
  serrugrams open                 Abre el navegador.
  serrugrams stop                 Apaga el servidor.
  serrugrams logs [-f]            Lo que imprimió el servidor; -f lo sigue en vivo.
  serrugrams mcp --root <carpeta> Servidor MCP por stdio, para agentes (Claude Code, Codex, Cursor…).

Opciones:
  --port N     Puerto del servidor (por defecto ${DEFAULT_PORT}).
  --fg         Queda en esta terminal en vez de ir de fondo (se apaga con Ctrl+C).
  --no-open    No abre el navegador.
  --json       Con ls: salida en JSON.

Todo se guarda en ${tildify(HOME)}: workspace.json (la vista), server.json y server.log.`;

// ---------- argumentos ----------

async function main(args) {
  const flags = new Set();
  const positional = [];
  let port;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port") port = parsePort(args[++i]);
    else if (a.startsWith("--port=")) port = parsePort(a.slice(7));
    else if (a === "-h" || a === "--help") flags.add("help");
    else if (a === "-f") flags.add("follow");
    else if (a.startsWith("-")) flags.add(a.replace(/^-+/, ""));
    else positional.push(a);
  }
  const command = COMMANDS.has(positional[0]) ? positional.shift() : "start";
  const opts = { port, fg: flags.has("fg"), open: !flags.has("no-open"), follow: flags.has("follow"), json: flags.has("json") };

  if (flags.has("help") || command === "help") return console.log(HELP);
  if (command === "ls" || command === "list") return list(opts);
  if (command === "remove" || command === "rm") return remove(positional[0], opts);
  if (command === "stop") return stop(opts);
  if (command === "open") return openCmd(opts);
  if (command === "logs") return logs(opts);
  return start(positional, opts);
}

function parsePort(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) fail(`Puerto inválido: ${v ?? "(vacío)"}`);
  return n;
}

function passthroughMcp(rest) {
  const child = spawn(process.execPath, [serverScript("mcp"), ...rest], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

// ---------- estado del servidor ----------

function readState() {
  try {
    return JSON.parse(readFileSync(STATE, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  mkdirSync(HOME, { recursive: true });
  const tmp = `${STATE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, STATE);
}

function clearState() {
  rmSync(STATE, { force: true });
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** La vista del serrugrams que responde en ese puerto, o null si ahí no hay uno. */
async function probe(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/tree`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = await res.json();
    return Array.isArray(body.refs) ? body : null;
  } catch {
    return null;
  }
}

async function portBusy(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
    return true;
  } catch (e) {
    return e?.cause?.code !== "ECONNREFUSED";
  }
}

function pidOnPort(port) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return Number(out.trim().split("\n")[0]) || null;
  } catch {
    return null;
  }
}

/**
 * El servidor que está corriendo: el anotado en server.json si sigue vivo, o uno que responda en el puerto
 * (por ejemplo, levantado a mano con `node server/index.ts`). Si server.json quedó viejo, se borra.
 */
async function running(port) {
  const state = readState();
  if (state && pidAlive(state.pid) && (await probe(state.port))) return state;
  if (state) clearState();
  const p = port ?? DEFAULT_PORT;
  if (await probe(p)) return { pid: pidOnPort(p), port: p, external: true };
  return null;
}

// ---------- comandos ----------

async function start(paths, opts) {
  let server = await running(opts.port);
  if (server && opts.port && server.port !== opts.port) {
    fail(`Ya hay un serrugrams en el puerto ${server.port}. Apagalo con \`serrugrams stop\` para usar otro puerto.`);
  }
  if (!server && opts.fg) return startForeground(paths, opts);
  if (!server) server = await startBackground(opts.port ?? DEFAULT_PORT);

  let openPath = "";
  for (const p of paths) {
    const ref = await addRef(server.port, p);
    console.log(`En la vista: ${ref.id} · ${tildify(ref.path)}`);
    if (ref.kind === "file" && ref.file && !openPath) openPath = ref.file;
  }
  const target = url(server.port) + (openPath ? "/#/" + encodeURI(openPath) : "");
  if (!paths.length) console.log(`Serrugrams en ${url(server.port)}`);
  if (opts.open) openBrowser(target);
}

async function addRef(port, p) {
  const abs = path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
  const res = await fetch(`http://127.0.0.1:${port}/api/refs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: abs }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) fail(`No se pudo sumar ${p}: ${body.error ?? res.statusText}`);
  return body.ref;
}

async function startBackground(port) {
  if (await portBusy(port)) fail(`El puerto ${port} está ocupado por otro programa. Probá con --port.`);
  mkdirSync(HOME, { recursive: true });
  const fd = openSync(LOG, "w");
  const child = spawn(process.execPath, [serverScript("index"), "--port", String(port)], { detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  let exited = false;
  child.on("exit", () => (exited = true));
  child.unref();

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !exited) {
    if (await probe(port)) {
      const state = { pid: child.pid, port, started: new Date().toISOString() };
      writeState(state);
      return state;
    }
    await sleep(150);
  }
  if (!exited) killQuietly(child.pid);
  fail(`No arrancó el servidor en el puerto ${port}.\n\n${tail(readLog(), 20)}`);
}

async function startForeground(paths, opts) {
  const port = opts.port ?? DEFAULT_PORT;
  if (await portBusy(port)) fail(`El puerto ${port} está ocupado por otro programa. Probá con --port.`);
  const abs = paths.map((p) => path.resolve(p.replace(/^~(?=$|\/)/, os.homedir())));
  const child = spawn(process.execPath, [serverScript("index"), "--port", String(port), ...abs], { stdio: "inherit" });
  writeState({ pid: child.pid, port, started: new Date().toISOString(), fg: true });
  if (opts.open) {
    (async () => {
      for (let k = 0; k < 100 && !(await probe(port)); k++) await sleep(150);
      openBrowser(url(port));
    })();
  }
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
  child.on("exit", (code) => {
    if (readState()?.pid === child.pid) clearState();
    process.exit(code ?? 0);
  });
}

async function list(opts) {
  const server = await running(opts.port);
  const view = server ? await probe(server.port) : null;
  // Sin servidor, la vista se lee del archivo.
  let refs = view?.refs;
  if (!refs) {
    try {
      refs = JSON.parse(readFileSync(WORKSPACE, "utf8")).refs.map((r) => ({ ...r, missing: !existsSync(r.path) }));
    } catch {
      refs = [];
    }
  }
  if (opts.json) return console.log(JSON.stringify({ server, refs }, null, 2));

  if (server) {
    const how = server.external ? "levantado a mano" : server.fg ? "en una terminal" : ago(server.started);
    console.log(`Servidor: ${url(server.port)} · pid ${server.pid ?? "?"} · ${how}`);
  } else {
    console.log("Servidor: apagado (levantalo con `serrugrams`)");
  }
  if (!refs.length) return console.log("\nLa vista está vacía. Sumá algo con `serrugrams <ruta>` o desde la interfaz.");
  console.log("");
  const rows = refs.map((r) => [r.id, r.kind === "file" || r.path.endsWith(".excalidraw") ? "diagrama" : "carpeta", tildify(r.path) + (r.missing ? "  (no se encuentra)" : "")]);
  const head = ["NOMBRE", "TIPO", "RUTA"];
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  for (const r of [head, ...rows]) console.log(r.map((v, c) => v.padEnd(widths[c])).join("  ").trimEnd());
}

async function remove(arg, opts) {
  if (!arg) fail("Decime qué quitar: `serrugrams remove <nombre|ruta>` (mirá los nombres con `serrugrams ls`).");
  const server = await running(opts.port);
  const view = server ? await probe(server.port) : null;
  let refs = view?.refs;
  if (!refs) {
    try {
      refs = JSON.parse(readFileSync(WORKSPACE, "utf8")).refs;
    } catch {
      refs = [];
    }
  }
  const abs = real(path.resolve(arg.replace(/^~(?=$|\/)/, os.homedir())));
  const ref = refs.find((r) => r.id === arg) ?? refs.find((r) => r.path === abs);
  if (!ref) fail(`"${arg}" no está en la vista. Mirá qué hay con \`serrugrams ls\`.`);

  if (server) {
    const res = await fetch(`http://127.0.0.1:${server.port}/api/refs?id=${encodeURIComponent(ref.id)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: "{}" });
    if (!res.ok) fail(`No se pudo quitar ${ref.id}: ${(await res.json().catch(() => ({}))).error ?? res.statusText}`);
  } else {
    const data = JSON.parse(readFileSync(WORKSPACE, "utf8"));
    data.refs = data.refs.filter((r) => r.id !== ref.id);
    const tmp = `${WORKSPACE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    renameSync(tmp, WORKSPACE);
  }
  console.log(`Quitado de la vista: ${ref.id} · ${tildify(ref.path)} (no se borró nada)`);
}

async function stop(opts) {
  const server = await running(opts.port);
  if (!server) return console.log("Serrugrams no está corriendo.");
  if (!server.pid) fail(`No sé qué proceso es el del puerto ${server.port}; cerralo desde su terminal.`);
  await terminate(server.pid);
  clearState();
  console.log(`Apagado ${url(server.port)}`);
}

async function openCmd(opts) {
  const server = await running(opts.port);
  if (!server) fail("Serrugrams no está corriendo. Levantalo con `serrugrams`.");
  console.log(url(server.port));
  openBrowser(url(server.port));
}

async function logs(opts) {
  if (readState()?.fg) fail("El servidor corre en una terminal: los mensajes están ahí.");
  if (!existsSync(LOG)) fail("Todavía no hay log. Levantá el servidor con `serrugrams`.");
  if (opts.follow) {
    const t = spawn("tail", ["-n", "40", "-f", LOG], { stdio: "inherit" });
    t.on("exit", (code) => process.exit(code ?? 0));
    return;
  }
  console.log(tail(readLog(), 40));
}

// ---------- utilidades ----------

const url = (port) => `http://localhost:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function real(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function tildify(p) {
  const h = os.homedir();
  return p === h || p.startsWith(h + path.sep) ? "~" + p.slice(h.length) : p;
}

function readLog() {
  try {
    return readFileSync(LOG, "utf8");
  } catch {
    return "";
  }
}

function tail(text, n) {
  return text.trimEnd().split("\n").slice(-n).join("\n");
}

function killQuietly(pid, sig = "SIGTERM") {
  try {
    process.kill(pid, sig);
  } catch {}
}

async function terminate(pid) {
  killQuietly(pid);
  for (let k = 0; k < 30 && pidAlive(pid); k++) await sleep(100);
  if (pidAlive(pid)) killQuietly(pid, "SIGKILL");
}

function openBrowser(target) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
  try {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true });
    p.on("error", () => console.log(`Abrilo a mano: ${target}`));
    p.unref();
  } catch {
    console.log(`Abrilo a mano: ${target}`);
  }
}

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (!Number.isFinite(s)) return "?";
  if (s < 60) return "desde hace segundos";
  if (s < 3600) return `desde hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `desde hace ${Math.round(s / 3600)} h`;
  return `desde hace ${Math.round(s / 86400)} días`;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

// Al final, para que todas las constantes de arriba ya estén definidas.
const argv = process.argv.slice(2);
if (argv[0] === "mcp") passthroughMcp(argv.slice(1));
else await main(argv);
