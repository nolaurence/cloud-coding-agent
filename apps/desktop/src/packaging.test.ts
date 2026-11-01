import assert from "node:assert/strict";
import fs from "node:fs";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

interface PackageManifest {
  name: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
}

test("the production dependency tree includes all required DSH runtime peers", () => {
  const packages = new Map<string, PackageManifest>();
  const visited = new Set<string>();
  const visit = (directory: string) => {
    const realDirectory = fs.realpathSync(directory);
    if (visited.has(realDirectory)) return;
    visited.add(realDirectory);
    const filename = path.join(realDirectory, "package.json");
    const manifest = JSON.parse(fs.readFileSync(filename, "utf8")) as PackageManifest;
    packages.set(manifest.name, manifest);
    const require = createRequire(filename);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
      if (builtinModules.includes(dependency)) continue;
      const dependencyDirectory = require.resolve.paths(dependency)
        ?.map((base) => path.join(base, dependency))
        .find((candidate) => fs.existsSync(path.join(candidate, "package.json")));
      assert.ok(dependencyDirectory, `${manifest.name} is missing dependency ${dependency}`);
      visit(dependencyDirectory);
    }
  };
  visit(fileURLToPath(new URL("../../server/", import.meta.url)));
  const missing: string[] = [];
  for (const manifest of packages.values()) {
    if (!manifest.name.startsWith("@deepseek-ai/")) continue;
    for (const peer of Object.keys(manifest.peerDependencies ?? {})) {
      if (!manifest.peerDependenciesMeta?.[peer]?.optional && !packages.has(peer)) {
        missing.push(`${manifest.name} requires ${peer}`);
      }
    }
  }
  assert.deepEqual(missing, [], "electron-builder omits peers that are not reachable through production dependencies");
});
