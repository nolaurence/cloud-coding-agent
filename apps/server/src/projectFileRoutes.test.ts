import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import Fastify from "fastify";
import type { ThreadMeta } from "@cca/protocol";
import { deleteProjectFile, openProjectFileDownload } from "./workspace.js";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cca-project-file-tests-"));
const previousDataDir = process.env.CCA_DATA_DIR;
process.env.CCA_DATA_DIR = testRoot;
const { store } = await import("./store.js");
const { registerProjectFileRoutes } = await import("./projectFileRoutes.js");
const { Hub } = await import("./hub.js");

after(() => {
  if (previousDataDir === undefined) delete process.env.CCA_DATA_DIR;
  else process.env.CCA_DATA_DIR = previousDataDir;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

function fixture(context: TestContext) {
  const root = fs.mkdtempSync(path.join(testRoot, "workspace-"));
  const previousProjects = store.projects;
  const previousThreads = store.threads;
  store.projects = [{ id: "project", name: "工作区", path: root, ownerId: "owner" }];
  store.threads = [];
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "keep.txt"), "keep");
  context.after(() => {
    store.projects = previousProjects;
    store.threads = previousThreads;
  });
  return root;
}

function routes(context: TestContext) {
  const app = Fastify();
  registerProjectFileRoutes(app, (header) => header?.startsWith("Bearer ")
    ? { username: header.slice(7), role: header === "Bearer admin" ? "admin" : "user" }
    : null);
  context.after(() => app.close());
  return app;
}

const downloadUrl = (filePath: string) => `/api/projects/project/files/download?path=${encodeURIComponent(filePath)}`;
const previewUrl = (filePath: string) => `/api/projects/project/files/preview?path=${encodeURIComponent(filePath)}`;
const headers = { authorization: "Bearer owner" };

test("downloads original binary bytes beyond the preview limit with safe Unicode filenames", async (context) => {
  const root = fixture(context);
  const app = routes(context);
  const name = "报告 #100% '最终'.bin";
  const content = Buffer.alloc(2 * 1024 * 1024 + 7);
  for (let index = 0; index < content.length; index++) content[index] = index % 256;
  fs.writeFileSync(path.join(root, "src", name), content);
  const response = await app.inject({ url: downloadUrl(`src/${name}`), headers });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.rawPayload, content);
  assert.equal(response.headers["content-length"], String(content.length));
  assert.equal(response.headers["content-type"], "application/octet-stream");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.match(String(response.headers["content-disposition"]), /^attachment; filename="download"; filename\*=UTF-8''/);
  assert.ok(String(response.headers["content-disposition"]).endsWith(encodeURIComponent(name).replace(/'/g, "%27")));
  fs.writeFileSync(path.join(root, "empty.txt"), "");
  const empty = await app.inject({ url: downloadUrl("empty.txt"), headers });
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.rawPayload.length, 0);
});

test("previews project images inline with safe headers and rejects other file types", async (context) => {
  const root = fixture(context);
  const app = routes(context);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
  fs.writeFileSync(path.join(root, "src", "界面.PNG"), png);
  const response = await app.inject({ url: previewUrl("src/界面.PNG"), headers });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.rawPayload, png);
  assert.equal(response.headers["content-type"], "image/png");
  assert.equal(response.headers["content-length"], String(png.length));
  assert.equal(response.headers["content-disposition"], "inline");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["x-content-type-options"], "nosniff");
  assert.equal((await app.inject(previewUrl("src/界面.PNG"))).statusCode, 401);
  assert.equal((await app.inject({ url: previewUrl("src/界面.PNG"), headers: { authorization: "Bearer other" } })).statusCode, 403);
  assert.equal((await app.inject({ url: previewUrl("src/keep.txt"), headers })).statusCode, 415);
  assert.equal((await app.inject({ url: previewUrl("missing.png"), headers })).statusCode, 404);
  assert.ok([400, 404].includes((await app.inject({ url: previewUrl("../secret.png"), headers })).statusCode));
  assert.throws(() => openProjectFileDownload(root, "src/界面.PNG", 1), { code: "EFBIG" });
});

test("project downloads enforce authentication, ownership and valid paths", async (context) => {
  const root = fixture(context);
  const app = routes(context);
  assert.equal((await app.inject(downloadUrl("src/keep.txt"))).statusCode, 401);
  for (const user of ["other", "admin"]) {
    assert.equal((await app.inject({ url: downloadUrl("src/keep.txt"), headers: { authorization: `Bearer ${user}` } })).statusCode, 403);
  }
  for (const invalid of ["", ".", "src", "../secret", path.join(root, "src", "keep.txt"), "src/keep.txt\0"]) {
    const response = await app.inject({ url: downloadUrl(invalid), headers });
    assert.ok([400, 404].includes(response.statusCode), `${invalid}: ${response.statusCode}`);
  }
  assert.equal((await app.inject({ url: downloadUrl("missing.txt"), headers })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/projects/project/files/download?path=a&path=b", headers })).statusCode, 400);
  assert.equal((await app.inject({ url: "/api/projects/missing/files/download?path=a", headers })).statusCode, 403);
});

test("file operations reject escaping symlinks and deletion through internal links", async (context) => {
  const root = fixture(context);
  const outside = fs.mkdtempSync(path.join(testRoot, "outside-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
  try {
    fs.symlinkSync(outside, path.join(root, "external"), "junction");
    fs.symlinkSync(path.join(root, "src"), path.join(root, "internal"), "junction");
    fs.symlinkSync(path.join(root, "src", "keep.txt"), path.join(root, "link.txt"), "file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return context.skip("当前环境不允许创建符号链接");
    throw error;
  }
  const app = routes(context);
  assert.equal((await app.inject({ url: downloadUrl("external/secret.txt"), headers })).statusCode, 400);
  for (const target of ["external/secret.txt", "internal/keep.txt", "link.txt"]) {
    assert.throws(() => deleteProjectFile(root, target));
  }
  assert.throws(() => openProjectFileDownload(root, "external/secret.txt"));
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "secret");
  assert.equal(fs.existsSync(path.join(root, "src", "keep.txt")), true);
});

test("delete removes only regular files, without the preview size or encoding limits", (context) => {
  const root = fixture(context);
  fs.writeFileSync(path.join(root, "src", "large.bin"), Buffer.alloc(2 * 1024 * 1024));
  deleteProjectFile(root, "src/large.bin");
  assert.equal(fs.existsSync(path.join(root, "src", "large.bin")), false);
  assert.equal(fs.existsSync(path.join(root, "src", "keep.txt")), true);
  for (const target of ["", ".", "src", "missing", "../secret", path.join(root, "src", "keep.txt")]) {
    assert.throws(() => deleteProjectFile(root, target));
  }
});

test("WebSocket deletion is restricted to project and thread owners", async (context) => {
  const root = fixture(context);
  const hub = Object.assign(Object.create(Hub.prototype), { provisionalThreads: new Map() }) as {
    onMessage(conn: unknown, raw: string): Promise<void>;
  };
  const thread: ThreadMeta = { id: "thread", projectId: "project", title: "测试", userId: "owner",
    archived: false, createdAt: 1, updatedAt: 1 };
  const sendDelete = async (username: string, threadId: string) => {
    const replies: { ok: boolean; error?: string }[] = [];
    const conn = { user: { username, role: username === "admin" ? "admin" : "user" }, socket: {
      readyState: 1, OPEN: 1, send: (raw: string) => replies.push(JSON.parse(raw)),
    } };
    await hub.onMessage(conn, JSON.stringify({ id: "delete", type: "project.file.delete", projectId: "project", threadId, path: "src/keep.txt" }));
    return replies.at(-1)!;
  };
  for (const username of ["other", "admin"]) {
    assert.equal((await sendDelete(username, "new-thread")).ok, false);
    assert.equal(fs.existsSync(path.join(root, "src", "keep.txt")), true);
  }
  store.threads = [{ ...thread, userId: "other" }];
  assert.equal((await sendDelete("owner", thread.id)).ok, false);
  store.threads = [{ ...thread, projectId: "different-project" }];
  assert.equal((await sendDelete("owner", thread.id)).ok, false);
  store.threads = [thread];
  assert.equal((await sendDelete("admin", thread.id)).ok, false);
  assert.equal((await sendDelete("owner", thread.id)).ok, true);
  assert.equal(fs.existsSync(path.join(root, "src", "keep.txt")), false);
  fs.writeFileSync(path.join(root, "src", "keep.txt"), "again");
  assert.equal((await sendDelete("owner", "new-thread")).ok, true);
});
