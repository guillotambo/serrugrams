import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:4747", changeOrigin: false } },
  },
  // dist/ui: la UI. El servidor compilado va a dist/server (tsconfig.build.json).
  build: { outDir: "dist/ui", chunkSizeWarningLimit: 4000 },
});
