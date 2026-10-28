import { build } from "esbuild";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(repositoryRoot, "packages/dsh-ui-trajectory");
const outputRoot = path.join(repositoryRoot, "apps/server/dist/dsh-ui-trajectory");
const sourceRequire = createRequire(path.join(sourceRoot, "package.json"));
const { transform } = sourceRequire("lightningcss");

// These identities belong to the DSH iframe's module table, including its React
// runtime. All trajectory components, event projections and styles bundle here.
const sharedModules = [
  "react", "react/jsx-runtime", "react-dom", "react-dom/client",
  "@deepseek-ai/cordis", "zod", "@tanstack/react-virtual",
  "@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-dockkit",
];
const inlineDshModules = new Set([
  "@deepseek-ai/dsh-llm/assistant-stream",
  "@deepseek-ai/dsh-util-values",
  "@deepseek-ai/dsh-brand",
  "@deepseek-ai/dsh-util-crypto",
]);

/** Build the local trajectory plugin into the server's shipped artifact tree. */
export async function buildDshTrajectory() {
  const manifest = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
  const license = await readFile(path.join(sourceRoot, "LICENSE"), "utf8");
  await mkdir(outputRoot, { recursive: true });
  const client = await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [path.join(sourceRoot, "src/client/index.ts")],
    outfile: path.join(outputRoot, "client.js"),
    bundle: true,
    platform: "browser",
    format: "cjs",
    target: "es2022",
    jsx: "automatic",
    minify: true,
    sourcemap: true,
    metafile: true,
    legalComments: "eof",
    external: sharedModules,
    define: { "process.env.NODE_ENV": '"production"' },
    banner: { js: `/* DeepSeek Harness trajectory source; MIT. See LICENSE and THIRD_PARTY_LICENSES.txt. */\nwindow.__ModuleLoader__.load({id:${JSON.stringify(manifest.name)},factory:(require)=>{var module={exports:{}};var exports=module.exports;` },
    footer: { js: "return module.exports;}});" },
    plugins: [{
      name: "trajectory-source-bundle",
      setup(context) {
        context.onResolve({ filter: /^@deepseek-ai\// }, (args) => {
          if (sharedModules.includes(args.path)) return { path: args.path, external: true };
          if (inlineDshModules.has(args.path)) return undefined;
          return { errors: [{ text: `Trajectory cannot inline a DSH feature plugin: ${args.path}` }] };
        });
        context.onLoad({ filter: /\.module\.css$/ }, async (args) => {
          const filename = path.relative(sourceRoot, args.path).split(path.sep).join("/");
          const { code, exports: classes } = transform({
            filename,
            code: await readFile(args.path),
            cssModules: { pattern: "[hash]_[local]" },
            minify: true,
          });
          const classMap = Object.fromEntries(Object.entries(classes ?? {}).map(([key, value]) => [key, value.name]));
          const tagId = `${manifest.name}/${filename}`;
          return {
            loader: "js",
            contents: `const id=${JSON.stringify(tagId)};
if (!document.querySelector('style[data-plugin-css='+JSON.stringify(id)+']')) {
  const style=document.createElement('style');
  style.dataset.plugin=${JSON.stringify(manifest.name)};
  style.dataset.pluginCss=id;
  style.textContent=${JSON.stringify(code.toString())};
  document.head.appendChild(style);
}
export default ${JSON.stringify(classMap)};`,
          };
        });
      },
    }],
  });
  for (const output of Object.values(client.metafile.outputs)) {
    for (const item of output.imports) {
      if (item.external && !sharedModules.includes(item.path)) {
        throw new Error(`Trajectory bundle retains an unprovided module: ${item.path}`);
      }
    }
  }
  const inputs = Object.keys(client.metafile.inputs);
  if (!inputs.includes("packages/dsh-ui-trajectory/src/client/TrajectoryView.tsx") ||
      inputs.some(input => input.includes("node_modules/@deepseek-ai/dsh-client-ui-trajectory/"))) {
    throw new Error("Trajectory must bundle the CCA-owned source, not the npm trajectory plugin");
  }
  await build({
    absWorkingDir: repositoryRoot,
    entryPoints: [path.join(sourceRoot, "src/index.ts")],
    outfile: path.join(outputRoot, "index.js"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    legalComments: "eof",
  });
  const runtimeManifest = {
    name: manifest.name, version: manifest.version, private: true, type: "module",
    license: manifest.license, main: "index.js",
    exports: { ".": "./index.js", "./client": "./client.js", "./package.json": "./package.json" },
    dsh: manifest.dsh,
  };
  const diffLicense = await readFile(path.join(path.dirname(sourceRequire.resolve("diff/package.json")), "LICENSE"), "utf8");
  await Promise.all([
    writeFile(path.join(outputRoot, "package.json"), `${JSON.stringify(runtimeManifest, null, 2)}\n`),
    writeFile(path.join(outputRoot, "bundle-meta.json"), `${JSON.stringify(client.metafile, null, 2)}\n`),
    writeFile(path.join(outputRoot, "THIRD_PARTY_LICENSES.txt"), `${license}\n--- diff ---\n\n${diffLicense}`),
    copyFile(path.join(sourceRoot, "LICENSE"), path.join(outputRoot, "LICENSE")),
    copyFile(path.join(sourceRoot, "upstream.json"), path.join(outputRoot, "upstream.json")),
  ]);
  console.log(`Bundled ${manifest.name} from ${inputs.length} source inputs into apps/server/dist/dsh-ui-trajectory`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDshTrajectory();
}
