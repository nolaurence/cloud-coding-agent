import { build } from "esbuild";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const serverRoot = fileURLToPath(new URL("../server/", import.meta.url));
await build({
  absWorkingDir: serverRoot,
  entryPoints: ["src/index.ts"], outfile: "dist/index.js", bundle: true, platform: "node", target: "node22", format: "esm", sourcemap: true,
  plugins: [{ name: "externalize-third-party", setup(context) {
    context.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === "entry-point" || args.path.startsWith("@cca/")) return undefined;
      if (args.path.startsWith("node:") || builtinModules.includes(args.path)) return { path: args.path, external: true };
      return { path: args.path, external: true };
    });
  } }],
});
