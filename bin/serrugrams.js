#!/usr/bin/env node
// Uso: serrugrams [carpeta] [--port 4747]   |   serrugrams mcp [--root carpeta]
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [first, ...rest] = process.argv.slice(2);
const isMcp = first === "mcp";
const name = isMcp ? "mcp" : "index";
// En el repo clonado corre el TypeScript directo (siempre al día); el paquete npm no trae server/ y usa el compilado.
const source = path.join(here, "..", "server", name + ".ts");
const script = existsSync(source) ? source : path.join(here, "..", "dist", "server", name + ".js");
const args = isMcp ? rest : process.argv.slice(2);
const child = spawn(process.execPath, [script, ...args], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
