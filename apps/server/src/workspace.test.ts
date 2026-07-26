import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { searchFiles } from "./files.js";
import {
  listProjectDirectory,
  listProjectFiles,
  readProjectFile,
  writeProjectFile,
} from "./workspace.js";

const VALID_VERSION = "0".repeat(64);

function versionOf(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

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
  assert.ok(Number.isFinite(content.modifiedAt));
  assert.match(content.version, /^[a-f0-9]{64}$/);

  assert.throws(() => listProjectDirectory(root, "README.md"), /目标不是目录/);
  assert.throws(() => listProjectDirectory(root, "../"), /文件不在项目目录内/);
  assert.throws(() => readProjectFile(root, "../outside.txt"), /(ENOENT|文件不在项目目录内)/);
  assert.throws(() => readProjectFile(root, ""), /文件路径无效/);
});

test("writeProjectFile saves UTF-8 text and truncates previous content", async (t) => {
  const root = await fixture(t);
  const initial = readProjectFile(root, "src/alpha.ts");

  const result = writeProjectFile(root, "src/alpha.ts", "你好\n", initial.version);

  assert.equal(result.path, "src/alpha.ts");
  assert.equal(result.size, Buffer.byteLength("你好\n"));
  assert.ok(Number.isFinite(result.modifiedAt));
  assert.match(result.version, /^[a-f0-9]{64}$/);
  assert.equal(await fs.readFile(path.join(root, "src", "alpha.ts"), "utf8"), "你好\n");
  assert.equal(readProjectFile(root, "src/alpha.ts").version, result.version);
});

test("writeProjectFile rejects unsafe or unsupported targets", async (t) => {
  const root = await fixture(t);

  assert.throws(() => writeProjectFile(root, "../outside.txt", "nope", VALID_VERSION), /(ENOENT|文件不在项目目录内)/);
  assert.throws(() => writeProjectFile(root, "src", "nope", VALID_VERSION), /目标不是文件/);
  assert.throws(() => writeProjectFile(root, "missing.txt", "nope", VALID_VERSION), /ENOENT/);
  assert.throws(() => writeProjectFile(root, "README.md", "contains\0nul", VALID_VERSION), /UTF-8 文本/);
  assert.throws(() => writeProjectFile(root, "README.md", "\ud800", VALID_VERSION), /无效的 Unicode/);
  assert.throws(() => writeProjectFile(root, "README.md", "x".repeat(1024 * 1024 + 1), VALID_VERSION), /超过 1 MB/);
  assert.throws(() => writeProjectFile(root, "README.md", "nope", "invalid"), /文件版本无效/);
});

test("writeProjectFile cannot follow a symbolic link outside the project", async (t) => {
  const root = await fixture(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cca-workspace-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, "secret.txt"), "unchanged\n");

  try {
    await fs.symlink(outside, path.join(root, "outside-link"), "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("当前环境不允许创建符号链接");
      return;
    }
    throw error;
  }

  assert.throws(
    () => writeProjectFile(root, "outside-link/secret.txt", "changed\n", VALID_VERSION),
    /文件不在项目目录内/,
  );
  assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "unchanged\n");
});

test("writeProjectFile rejects a stale file version", async (t) => {
  const root = await fixture(t);
  const initial = readProjectFile(root, "src/alpha.ts");
  await fs.writeFile(path.join(root, "src", "alpha.ts"), "changed elsewhere\n");

  assert.throws(
    () => writeProjectFile(root, "src/alpha.ts", "browser edit\n", initial.version),
    /已被其他进程修改/,
  );
  assert.equal(await fs.readFile(path.join(root, "src", "alpha.ts"), "utf8"), "changed elsewhere\n");
});

test("readProjectFile rejects invalid UTF-8", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));

  assert.throws(() => readProjectFile(root, "invalid.txt"), /非 UTF-8/);
});

test("writeProjectFile refuses to replace an invalid UTF-8 source file", async (t) => {
  const root = await fixture(t);
  const invalid = Buffer.from([0xc3, 0x28]);
  await fs.writeFile(path.join(root, "invalid.txt"), invalid);

  assert.throws(
    () => writeProjectFile(root, "invalid.txt", "valid now\n", versionOf(invalid)),
    /非 UTF-8 文本无法保存/,
  );
  assert.deepEqual(await fs.readFile(path.join(root, "invalid.txt")), invalid);
});
