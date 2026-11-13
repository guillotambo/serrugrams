import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // `pnpm dev` levanta la API en 4848 para no chocar con el servidor de todos los días (4747).
    proxy: { "/api": { target: "http://127.0.0.1:4848", changeOrigin: false } },
  },
  // dist/ui: la UI. El servidor compilado va a dist/server (tsconfig.build.json).
  build: { outDir: "dist/ui", chunkSizeWarningLimit: 4000 },
});
