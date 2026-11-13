// Selector nativo (server/picker.ts): solo la elección de la carpeta inicial; el diálogo en sí no se puede automatizar.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs, realpathSync } from "node:fs";
import { startDirFor } from "./picker.ts";

let tmp: string;

before(async () => {
  tmp = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), "serrugrams-picker-")));
  await fs.mkdir(path.join(tmp, "repo", "docs"), { recursive: true });
  await fs.writeFile(path.join(tmp, "repo", "docs", "panorama.excalidraw"), "{}");
});

after(async () => {
  if (tmp) await fs.rm(tmp, { recursive: true, force: true });
});

test("startDirFor arranca en lo escrito si es una carpeta", () => {
  assert.equal(startDirFor(path.join(tmp, "repo", "docs")), path.join(tmp, "repo", "docs"));
});

test("startDirFor usa la carpeta del archivo escrito", () => {
  assert.equal(startDirFor(path.join(tmp, "repo", "docs", "panorama.excalidraw")), path.join(tmp, "repo", "docs"));
});

test("startDirFor sube hasta lo que existe si se está tipeando", () => {
  assert.equal(startDirFor(path.join(tmp, "repo", "doc")), path.join(tmp, "repo"));
  assert.equal(startDirFor(path.join(tmp, "repo", "nada", "mas")), path.join(tmp, "repo"));
});

test("startDirFor cae en la home sin nada escrito y entiende ~", () => {
  assert.equal(startDirFor(""), os.homedir());
  assert.equal(startDirFor(undefined), os.homedir());
  assert.equal(startDirFor("~"), os.homedir());
});
