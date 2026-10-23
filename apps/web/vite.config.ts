import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: {
    format: "es",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:8787", ws: true },
      "/api": { target: "http://localhost:8787", changeOrigin: true },
      // The DSH shell, its plugin bundles, and the remote.mux WebSocket are
      // owned by the server, including while the CCA shell runs on Vite.
      "/dsh": { target: "http://localhost:8787", changeOrigin: true, ws: true },
    },
  },
});
