import { build } from "esbuild";
import { builtinModules } from "node:module";

const shared = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  plugins: [{
    name: "externalize-third-party",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^[^./]/ }, (args) => {
        if (args.path.startsWith("@cca/")) return undefined;
        if (args.path === "electron" || args.path.startsWith("node:") || builtinModules.includes(args.path)) return { path: args.path, external: true };
        return { path: args.path, external: true };
      });
    },
  }],
};

await Promise.all([
  build({ ...shared, entryPoints: ["src/main.ts"], outfile: "dist/main.js", external: ["electron"] }),
  build({ ...shared, entryPoints: ["src/preload.ts"], outfile: "dist/preload.js", external: ["electron"] }),

]);
await import("./build-server.mjs");
