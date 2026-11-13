// Selector nativo de carpetas y diagramas para «Agregar a la vista». El navegador no le pasa a la página la ruta de un
// archivo (ni con un <input type=file> ni arrastrando desde Finder), así que el diálogo lo abre el servidor, que corre en
// la misma máquina. Por ahora solo en macOS (NSOpenPanel vía JXA, que deja elegir carpetas y archivos en el mismo
// diálogo); en el resto la UI esconde el botón y queda el campo con autocompletado.
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceError } from "./workspace.ts";
import { expandHome } from "./refs.ts";

export const pickerAvailable = process.platform === "darwin";

// `run(argv)` recibe la carpeta inicial. Devuelve la ruta elegida, o "" si se canceló.
const JXA = `
ObjC.import("AppKit");
function run(argv) {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var panel = $.NSOpenPanel.openPanel;
  panel.canChooseFiles = true;
  panel.canChooseDirectories = true;
  panel.allowsMultipleSelection = false;
  panel.canCreateDirectories = false;
  panel.allowedFileTypes = $(["excalidraw"]);
  panel.title = "Agregar a la vista";
  panel.message = "Elegí una carpeta o un archivo .excalidraw";
  panel.prompt = "Agregar";
  if (argv[0]) panel.directoryURL = $.NSURL.fileURLWithPath(argv[0]);
  app.activateIgnoringOtherApps(true);
  var res = panel.runModal;
  return res == $.NSModalResponseOK ? ObjC.unwrap(panel.URL.path) : "";
}
`;

/** La carpeta donde arranca el diálogo: lo escrito en el campo si existe (o su carpeta), si no, la home. */
export function startDirFor(typed: string | undefined): string {
  if (typed?.trim()) {
    let p = path.resolve(expandHome(typed.trim()));
    // Si lo escrito todavía no existe (se está tipeando), la carpeta más cercana hacia arriba que sí.
    while (!existsSync(p) && path.dirname(p) !== p) p = path.dirname(p);
    try {
      return statSync(p).isDirectory() ? p : path.dirname(p);
    } catch {}
  }
  return os.homedir();
}

let open: Promise<string | null> | null = null;

/** Abre el diálogo y espera a que el usuario elija. `null` si canceló. Si ya hay uno abierto, espera a ese. */
export function pickPath(typed?: string): Promise<string | null> {
  if (!pickerAvailable) return Promise.reject(new WorkspaceError(501, "El selector solo está disponible en macOS"));
  open ??= new Promise<string | null>((resolve, reject) => {
    execFile("osascript", ["-l", "JavaScript", "-e", JXA, startDirFor(typed)], (err, stdout) => {
      open = null;
      if (err) return reject(new WorkspaceError(500, "No se pudo abrir el selector"));
      const out = stdout.trim();
      resolve(out || null);
    });
  });
  return open;
}
