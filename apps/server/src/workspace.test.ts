import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { searchFiles } from "./files.js";
import { listProjectDirectory, listProjectFiles, readProjectFile } from "./workspace.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-workspace-"));
  await Promise.all([
    fs.mkdir(path.join(root, "src")),
    fs.mkdir(path.join(root, "node_modules")),
    fs.writeFile(path.join(root, "README.md"), "# fixture\n"),
    fs.writeFile(path.join(root, ".gitignore"), "node_modules\n"),
  ]);
  await Promise.all([
    fs.writeFile(path.join(root, "src", "zeta.ts"), "export const zeta = true;\n"),
    fs.writeFile(path.join(root, "src", "alpha.ts"), "export const alpha = true;\n"),
    fs.writeFile(path.join(root, "node_modules", "ignored.js"), "ignored\n"),
  ]);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("listProjectDirectory returns one sorted level with file metadata", async (t) => {
  const root = await fixture(t);

  const listing = listProjectDirectory(root);
  assert.equal(listing.path, "");
  assert.deepEqual(
    listing.entries.map(({ name, path: entryPath, kind }) => ({ name, path: entryPath, kind })),
    [
      { name: "src", path: "src", kind: "directory" },
      { name: ".gitignore", path: ".gitignore", kind: "file" },
      { name: "README.md", path: "README.md", kind: "file" },
    ],
  );
  assert.ok(listing.entries.every((entry) => Number.isFinite(entry.modifiedAt)));
  assert.equal(listing.entries.find((entry) => entry.name === "README.md")?.size, 10);

  const nested = listProjectDirectory(root, "src");
  assert.equal(nested.path, "src");
  assert.deepEqual(nested.entries.map((entry) => entry.name), ["alpha.ts", "zeta.ts"]);
});

test("recursive project files retain dotfiles and ignore generated directories", async (t) => {
  const root = await fixture(t);

  assert.deepEqual(listProjectFiles(root), [
    { path: "src", kind: "directory" },
    { path: "src/alpha.ts", kind: "file" },
    { path: "src/zeta.ts", kind: "file" },
    { path: ".gitignore", kind: "file" },
    { path: "README.md", kind: "file" },
  ]);
});

test("file search includes project dotfiles", async (t) => {
  const root = await fixture(t);

  assert.deepEqual(searchFiles(root, "gitignore"), [".gitignore"]);
  assert.deepEqual(searchFiles(root, "ignored.js"), []);
});

test("file and directory reads cannot escape the project", async (t) => {
  const root = await fixture(t);
  const content = readProjectFile(root, "src/alpha.ts");
  assert.equal(content.path, "src/alpha.ts");
  assert.equal(content.content, "export const alpha = true;\n");

  assert.throws(() => listProjectDirectory(root, "README.md"), /目标不是目录/);
  assert.throws(() => listProjectDirectory(root, "../"), /文件不在项目目录内/);
  assert.throws(() => readProjectFile(root, "../outside.txt"), /(ENOENT|文件不在项目目录内)/);
  assert.throws(() => readProjectFile(root, ""), /文件路径无效/);
});
