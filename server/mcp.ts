#!/usr/bin/env node
// Servidor MCP (stdio) de Serrugrams: permite a agentes leer y editar diagramas de
// Excalidraw del workspace. Solo escribe archivos; la UI (si está abierta) los
// recibe en vivo por el watcher del servidor HTTP.
//
// Uso: node server/mcp.ts [--root <dir>]   (o env SERRUGRAMS_ROOT; por defecto cwd)
// Una raíz relativa se resuelve desde la raíz del repo (el .git más cercano hacia arriba), así
// una sola configuración global con `--root docs/diagramas` sirve para todos los repos.
// Nunca escribir en stdout fuera del protocolo: los logs van a stderr.
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Workspace, gitRoot } from "./workspace.ts";
import { createMcpServer, skillBody } from "./mcpserver.ts";

const log = (...a: unknown[]) => console.error("[serrugrams-mcp]", ...a);

// --- Raíz del workspace ---
function rootFromArgs(): string {
  const args = process.argv.slice(2);
  const i = args.indexOf("--root");
  const fromFlag = i >= 0 ? args[i + 1] : args.find((a) => a.startsWith("--root="))?.slice(7);
  const given = fromFlag ?? process.env.SERRUGRAMS_ROOT;
  const cwd = process.cwd();
  if (!given) return cwd;
  return path.isAbsolute(given) ? path.resolve(given) : path.resolve(gitRoot(cwd) ?? cwd, given);
}
// La carpeta raíz no se crea al arrancar: aparece recién al escribir el primer diagrama.
// Con el MCP configurado globalmente, abrir una sesión en un repo no le deja un docs/diagramas vacío.
const ws = new Workspace(rootFromArgs());

// --- Archivos que viajan con el servidor (el fuente está en server/, el compilado en dist/server/) ---
const here = path.dirname(fileURLToPath(import.meta.url));
function shipped(rel: string): string | null {
  for (const up of ["..", "../.."]) {
    const abs = path.resolve(here, up, rel);
    if (existsSync(abs)) return abs;
  }
  return null;
}
const cliPath = shipped("bin/serrugrams.js");
const quote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
/** Comando que suma la carpeta de diagramas a la vista del usuario y abre la interfaz. */
const addToViewCommand = cliPath ? `node ${quote(cliPath)} ${quote(ws.root)}` : `serrugrams ${quote(ws.root)}`;

/** La skill (skills/serrugrams/SKILL.md) sin su encabezado YAML, para exponerla como prompt. */
function workflowText(): string | null {
  const file = shipped("skills/serrugrams/SKILL.md");
  if (!file) return null;
  return skillBody(readFileSync(file, "utf8"));
}

// Las herramientas viven en server/mcpserver.ts (las comparte el MCP de la nube).
const server = createMcpServer(ws, { addToView: addToViewCommand, workflow: workflowText(), log });

const transport = new StdioServerTransport();
await server.connect(transport);
log(`listo, workspace: ${ws.root}`);
