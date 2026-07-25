import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { browseDirectories, resolveProjectDirectory } from "./directories.js";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-directories-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("browseDirectories returns only sorted child directories", async (t) => {
  const root = await fixture(t);
  await Promise.all([
    fs.mkdir(path.join(root, "beta")),
    fs.mkdir(path.join(root, "alpha")),
    fs.mkdir(path.join(root, ".hidden")),
    fs.writeFile(path.join(root, "notes.txt"), "not a directory"),
  ]);

  const result = await browseDirectories(`${root}${path.sep}`);

  assert.equal(result.parentPath, path.resolve(root));
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    [".hidden", "alpha", "beta"].sort((left, right) => left.localeCompare(right)),
  );
  assert.ok(result.entries.every((entry) => path.dirname(entry.fullPath) === path.resolve(root)));
});

test("browseDirectories filters a partial directory name and hides unrelated dot directories", async (t) => {
  const root = await fixture(t);
  await Promise.all([
    fs.mkdir(path.join(root, "Projects")),
    fs.mkdir(path.join(root, "Pictures")),
    fs.mkdir(path.join(root, ".private")),
  ]);

  const result = await browseDirectories(path.join(root, "pro"));

  assert.deepEqual(result.entries.map((entry) => entry.name), ["Projects"]);
});

test("resolveProjectDirectory canonicalizes directories and rejects invalid targets", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, "file.txt");
  await fs.writeFile(file, "file");

  assert.equal(await resolveProjectDirectory(root), await fs.realpath(root));
  await assert.rejects(resolveProjectDirectory("relative/path"), /绝对路径/);
  await assert.rejects(resolveProjectDirectory(file), /不是目录/);
  await assert.rejects(resolveProjectDirectory(path.join(root, "missing")), /目录不存在/);
});
