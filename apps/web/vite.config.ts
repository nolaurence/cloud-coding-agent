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
      // DSH cookies and Origin checks require the browser's original Host.
      "/dsh": { target: "http://127.0.0.1:8787", ws: true },
      "/ws": { target: "ws://localhost:8787", ws: true },
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
