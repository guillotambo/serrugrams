// Borra dist/ antes de construir, para que no queden archivos de un build anterior en el paquete.
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

rmSync(join(dirname(fileURLToPath(import.meta.url)), "..", "dist"), { recursive: true, force: true });
