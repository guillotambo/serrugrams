#!/usr/bin/env node
// Uso: serrugrams [carpeta] [--port 4747]   |   serrugrams mcp [--root carpeta]
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const [first, ...rest] = process.argv.slice(2);
const isMcp = first === "mcp";
const script = path.join(here, "..", "server", isMcp ? "mcp.ts" : "index.ts");
const args = isMcp ? rest : process.argv.slice(2);
const child = spawn(process.execPath, [script, ...args], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
