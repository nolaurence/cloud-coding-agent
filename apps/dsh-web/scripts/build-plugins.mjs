/**
 * Build the vendored DSH client UI plugins into the official dynamic-bundle
 * format: `window.__ModuleLoader__.load({ id, factory(require) })`.
 *
 * DSH's own build uses tsdown + lightningcss with a private workspace preset.
 * The artifacts only need the same closure contract, so this script keeps the
 * source packages buildable inside this repository without importing the DSH
 * monorepo toolchain.
 */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { transform } from "lightningcss";

const appDir = fileURLToPath(new URL("..", import.meta.url));
const pluginsDir = path.join(appDir, "plugins");

/** Modules the DSH shell seeds into the frozen module table. */
const PLATFORM_MODULES = [
  "react",
  "react/jsx-runtime",
  "react-dom",
  "react-dom/client",
  "@deepseek-ai/cordis",
  "zod",
  "@tanstack/react-virtual",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit",
];

const CSS_MODULE_SUFFIX = ".module.css";
const STYLE_TAG = (pkgName, file, css) => [
  `const css = ${JSON.stringify(css)};`,
  `const tagId = ${JSON.stringify(`${pkgName}/${path.basename(file)}`)};`,
  "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
  "  const tag = document.createElement('style');",
  `  tag.dataset.plugin = ${JSON.stringify(pkgName)};`,
  "  tag.dataset.pluginCss = tagId;",
  "  tag.textContent = css;",
  "  document.head.appendChild(tag);",
  "}",
];

/**
 * Compile one stylesheet into the plugin's style-injection module. CSS Modules
 * exports a class map; kitchen-sink stylesheets just inject.
 */
function styleModule(pkgName, file, css, classMap) {
  const lines = STYLE_TAG(pkgName, file, css);
  lines.push(classMap === undefined ? "export {};" : `export default ${JSON.stringify(classMap)};`);
  return lines.join("\n");
}

function cssPlugin(pkgName) {
  return {
    name: "cca-dsh-css-modules",
    setup(buildApi) {
      buildApi.onLoad({ filter: /\.module\.css$/ }, async (args) => {
        const source = await readFile(args.path);
        const { code, exports } = transform({
          filename: args.path,
          code: source,
          cssModules: { pattern: "[hash]_[local]" },
          minify: true,
        });
        const classMap = {};
        for (const [local, value] of Object.entries(exports ?? {})) classMap[local] = value.name;
        return { contents: styleModule(pkgName, args.path, code.toString(), classMap), loader: "js" };
      });
      buildApi.onLoad({ filter: /\.css$/ }, async (args) => {
        const source = await readFile(args.path);
        const { code } = transform({ filename: args.path, code: source, minify: true });
        return { contents: styleModule(pkgName, args.path, code.toString(), undefined), loader: "js" };
      });
    },
  };
}

async function buildPlugin(pluginDir) {
  const manifest = JSON.parse(await readFile(path.join(pluginDir, "package.json"), "utf8"));
  const pkgName = manifest.name;
  if (typeof pkgName !== "string") throw new Error(`plugin manifest missing name: ${pluginDir}`);
  const clientEntry = path.join(pluginDir, "src", "client", "index.tsx");
  const clientEntryTs = path.join(pluginDir, "src", "client", "index.ts");
  const entry = existsSync(clientEntry) ? clientEntry : clientEntryTs;
  if (!existsSync(entry)) throw new Error(`plugin client entry missing: ${pluginDir}`);

  const external = new Set([...PLATFORM_MODULES, ...(manifest.dsh?.client?.external ?? [])]);
  const outDir = path.join(pluginDir, "lib");
  await mkdir(outDir, { recursive: true });

  await build({
    entryPoints: [entry],
    outfile: path.join(outDir, "client.js"),
    bundle: true,
    format: "cjs",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    sourcemap: true,
    external: [...external],
    define: {
      "process.env": "{}",
      "process.env.NODE_ENV": JSON.stringify("production"),
      "import.meta.env.MODE": JSON.stringify("production"),
      "import.meta.env": JSON.stringify({ MODE: "production" }),
    },
    banner: {
      js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkgName)}, factory: (require) => {\n`
        + "var module = { exports: {} };\nvar exports = module.exports;",
    },
    footer: { js: "return module.exports;\n} });" },
    plugins: [cssPlugin(pkgName)],
    logLevel: "info",
  });

  // The host Loader imports the node half. Client-only packages get a no-op
  // plugin so every row still composes through Cordis.
  const nodeEntry = path.join(pluginDir, "src", "index.ts");
  if (existsSync(nodeEntry)) {
    await build({
      entryPoints: [nodeEntry],
      outfile: path.join(outDir, "index.js"),
      bundle: false,
      format: "esm",
      platform: "node",
      target: "es2022",
      sourcemap: false,
      logLevel: "info",
    });
  } else {
    await writeFile(path.join(outDir, "index.js"), "export function apply() {}\n", "utf8");
  }
}

const selected = process.argv.slice(2);
const names = (await readdir(pluginsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && existsSync(path.join(pluginsDir, entry.name, "package.json")))
  .map((entry) => entry.name);
const todo = selected.length === 0 ? names : names.filter((name) => selected.includes(name));
if (todo.length === 0) throw new Error(`no DSH UI plugins matched ${selected.join(", ")}`);
for (const name of todo) {
  console.log(`[dsh-ui] building ${name}`);
  await buildPlugin(path.join(pluginsDir, name));
}
