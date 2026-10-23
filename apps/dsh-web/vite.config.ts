import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const src = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));

/**
 * The shell has no boot manifest of its own; only the CCA server can inject
 * the per-user DSH host page. A bare Vite dev server would render a broken
 * boot page, so fail with the supported workflow instead.
 */
function rejectStandaloneServe() {
  return {
    name: "cca-dsh-web-reject-standalone",
    config(_config: unknown, env: { command: string }) {
      if (env.command === "serve") {
        throw new Error(
          "apps/dsh-web is served by the CCA server at /dsh/. Run `npm run dev` from the repo root and open http://localhost:5173.",
        );
      }
    },
  };
}

export default defineConfig({
  // The app is served below /dsh/; relative asset URLs keep the same build
  // usable from a reverse-proxied prefix.
  base: "./",
  plugins: [rejectStandaloneServe(), react()],
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/index-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  resolve: {
    // npm nests the DSH client runtime deps under this workspace because their
    // React 18 peers conflict with the CCA app's React 19. Dedupe pins every
    // bare import to this app's copy instead of resolving from the importer.
    dedupe: [
      "react",
      "react-dom",
      "@tanstack/react-virtual",
      "@shikijs/langs",
      "anser",
      "clsx",
      "diff",
      "immer",
      "katex",
      "mdast-util-from-markdown",
      "mdast-util-gfm",
      "mdast-util-math",
      "micromark-core-commonmark",
      "micromark-extension-gfm",
      "micromark-extension-math",
      "micromark-factory-space",
      "micromark-util-character",
      "micromark-util-classify-character",
      "micromark-util-sanitize-uri",
      "micromark-util-symbol",
      "shiki",
      "simple-icons",
      "zod",
      "zustand",
    ],
    alias: [{ find: /^node:module$/, replacement: src("./src/node-module-stub.ts") }],
  },
  define: {
    // The DSH client packages read public build metadata from process.env.
    "process.env": "{}",
    "process.env.DSH_CLIENT_TITLE": JSON.stringify("Kloud Work"),
    "process.env.DSH_CLIENT_BUILD_PROFILE": JSON.stringify("local"),
    // The vendored Cordis loader probes Node internals at module scope.
    "process.versions.node": '"0.0.0"',
    "process.execArgv": "[]",
    "process.env.CORDIS_SHARED": "undefined",
    "process.env.NODE_ENV": JSON.stringify("production"),
    "import.meta.env.MODE": JSON.stringify("production"),
    "import.meta.env": JSON.stringify({ MODE: "production" }),
  },
});
