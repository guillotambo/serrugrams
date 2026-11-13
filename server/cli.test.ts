// Test end-to-end del CLI (bin/serrugrams.js): un solo servidor de fondo en un puerto alto, con la vista y el estado
// en una carpeta temporal (SERRUGRAMS_HOME). Verifica start, sumar a la vista, ls, remove (con y sin servidor) y stop.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "bin", "serrugrams.js");
const port = 47000 + Math.floor(Math.random() * 1500);
let tmp: string;
let env: NodeJS.ProcessEnv;

async function cli(...args: string[]) {
  try {
    const { stdout } = await run(process.execPath, [bin, ...args, "--no-open"], { env, cwd: tmp });
    return { code: 0, out: stdout };
  } catch (e: any) {
    return { code: e.code as number, out: `${e.stdout}${e.stderr}` };
  }
}
type Ls = { server: { pid: number; port: number } | null; refs: { id: string; path: string; kind?: string; missing?: boolean }[] };
const ls = async (): Promise<Ls> => JSON.parse((await cli("ls", "--json")).out);

before(async () => {
  tmp = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "serrugrams-cli-")));
  env = { ...process.env, SERRUGRAMS_HOME: path.join(tmp, "home"), SERRUGRAMS_PORT: String(port) };
  await fs.mkdir(path.join(tmp, "repo-a", "docs", "diagramas"), { recursive: true });
  await fs.mkdir(path.join(tmp, "repo-b"), { recursive: true });
  await fs.writeFile(path.join(tmp, "repo-b", "suelto.excalidraw"), JSON.stringify({ type: "excalidraw", version: 2, elements: [], appState: {}, files: {} }));
});

after(async () => {
  await cli("stop");
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test("levanta un solo servidor y suma carpetas y diagramas a la vista", async () => {
  const first = await cli("repo-a/docs/diagramas");
  assert.equal(first.code, 0, first.out);
  const second = await cli(path.join(tmp, "repo-b", "suelto.excalidraw"));
  assert.equal(second.code, 0, second.out);
  const again = await cli("repo-a/docs/diagramas");
  assert.equal(again.code, 0, again.out);

  const { server, refs } = await ls();
  assert.equal(server?.port, port);
  assert.deepEqual(
    refs.map((r) => [r.id, r.kind]),
    [
      ["repo-a", "folder"],
      ["repo-b", "file"],
    ],
  );
  const tree = await (await fetch(`http://127.0.0.1:${port}/api/tree`)).json();
  assert.ok(tree.entries.some((e: any) => e.path === "repo-b/suelto.excalidraw"));
});

test("una ruta que no existe da error claro", async () => {
  const r = await cli("no-existe");
  assert.equal(r.code, 1);
  assert.match(r.out, /No existe/);
});

test("remove por nombre con el servidor prendido", async () => {
  const r = await cli("remove", "repo-b");
  assert.match(r.out, /Quitado de la vista/);
  assert.deepEqual((await ls()).refs.map((x) => x.id), ["repo-a"]);
  // No se borra nada del disco.
  await fs.access(path.join(tmp, "repo-b", "suelto.excalidraw"));
});

test("stop, y la vista sigue en el archivo; remove funciona sin servidor", async () => {
  assert.match((await cli("stop")).out, /Apagado/);
  const off = await ls();
  assert.equal(off.server, null);
  assert.deepEqual(off.refs.map((x) => x.id), ["repo-a"]);
  assert.match((await cli("remove", "repo-a/docs/diagramas")).out, /Quitado/);
  assert.equal((await ls()).refs.length, 0);
});

test("si el proceso murió, el estado viejo no confunde", async () => {
  await cli();
  const { server } = await ls();
  process.kill(server!.pid);
  for (let k = 0; k < 30; k++) {
    try {
      process.kill(server!.pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      break;
    }
  }
  assert.equal((await ls()).server, null);
  assert.match((await cli("stop")).out, /no está corriendo/);
});
