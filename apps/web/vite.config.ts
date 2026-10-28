import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function trajectorySource(): Plugin {
  return {
    name: "cca-trajectory-source",
    apply: "build",
    generateBundle() {
      const ids = [...this.getModuleIds()];
      if (!ids.some(id => id.includes("/packages/dsh-ui-trajectory/src/client/TrajectoryView.tsx")) ||
          ids.some(id => id.includes("/node_modules/@deepseek-ai/dsh-client-ui-trajectory/"))) {
        throw new Error("轨迹页必须从 CCA 本地源码构建");
      }
      const sourceRoot = new URL("../../packages/dsh-ui-trajectory/", import.meta.url);
      const sourceRequire = createRequire(new URL("package.json", sourceRoot));
      const diffLicense = path.join(path.dirname(sourceRequire.resolve("diff/package.json")), "LICENSE");
      this.emitFile({ type: "asset", fileName: "licenses/dsh-trajectory.txt", source:
        readFileSync(new URL("LICENSE", sourceRoot), "utf8") + "\n--- diff ---\n" + readFileSync(diffLicense, "utf8"),
      });
      this.emitFile({ type: "asset", fileName: "licenses/dsh-trajectory-source.json", source:
        readFileSync(new URL("upstream.json", sourceRoot), "utf8"),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), trajectorySource()],
  worker: {
    format: "es",
  },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: "ws://localhost:8787", ws: true },
      "/api": { target: "http://localhost:8787", changeOrigin: true },
    },
  },
});
