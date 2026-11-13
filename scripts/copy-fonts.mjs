// Copia las fuentes de Excalidraw a public/fonts (gitignoreado) para servirlas en local.
// Corre al empezar `pnpm dev` y `pnpm build`; también se puede lanzar a mano con `pnpm fonts`.
import { cpSync, existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dest = join(root, "public", "fonts");

let src;
try {
  // Se resuelve por el paquete (con pnpm, node_modules es un symlink al store).
  const require = createRequire(join(root, "package.json"));
  const entry = require.resolve("@excalidraw/excalidraw");
  src = join(entry.slice(0, entry.lastIndexOf("/dist/")), "dist", "prod", "fonts");
} catch {
  src = undefined;
}

if (!src || !existsSync(src)) {
  console.warn("[serrugrams] No se encontraron las fuentes de @excalidraw/excalidraw; se usarán las del sistema.");
  process.exit(0);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true, dereference: true });
console.log("[serrugrams] Fuentes copiadas a public/fonts");
