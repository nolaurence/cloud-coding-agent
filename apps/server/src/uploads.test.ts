import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import Fastify from "fastify";
import type { ThreadMeta, TurnAttachment } from "@cca/protocol";

const testRoot = fs.mkdtempSync(path.join(process.cwd(), ".uploads-test-"));
const originalDataDir = process.env.CCA_DATA_DIR;
process.env.CCA_DATA_DIR = testRoot;
const {
  MAX_FILE_SIZE, MAX_USER_UPLOADS_SIZE, storeUploadedFile, storeUploadedImage,
  uploadDirectory, validateTurnAttachments, readStoredImage, removeUploadedImages, removeThreadUploads,
} = await import("./uploads.js");
const { registerUploadRoutes } = await import("./uploadRoutes.js");
const { store } = await import("./store.js");
const shares = await import("./threadShares.js");
after(() => {
  if (originalDataDir === undefined) delete process.env.CCA_DATA_DIR;
  else process.env.CCA_DATA_DIR = originalDataDir;
  fs.rmSync(testRoot, { recursive: true, force: true });
});
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ6sAAAAASUVORK5CYII=", "base64");

function fixture(t: TestContext) {
  const workspace = fs.mkdtempSync(path.join(testRoot, "workspace-"));
  const outside = fs.mkdtempSync(path.join(testRoot, "outside-"));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "inside.ts"), "export {};\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  t.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  return { workspace, outside };
}

test("resolves relative file attachments inside the workspace", (t) => {
  const { workspace } = fixture(t);
  const attachments: TurnAttachment[] = [{ path: "src/inside.ts", displayName: "src/inside.ts" }];

  validateTurnAttachments("user", workspace, attachments);

  assert.equal(attachments[0]?.path, fs.realpathSync(path.join(workspace, "src", "inside.ts")));
});

test("rejects outside and missing file attachments", (t) => {
  const { workspace, outside } = fixture(t);
  for (const target of [path.join(outside, "secret.txt"), "../outside.txt", "missing.txt"]) {
    const attachments: TurnAttachment[] = [{ path: target, displayName: "file" }];
    assert.throws(() => validateTurnAttachments("user", workspace, attachments), /不属于当前工作区/);
  }
});

test("rejects attachments reached through an escaping symbolic link", (t) => {
  const { workspace, outside } = fixture(t);
  try {
    fs.symlinkSync(outside, path.join(workspace, "outside-link"), "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("当前环境不允许创建符号链接");
      return;
    }
    throw error;
  }
  const attachments: TurnAttachment[] = [{ path: "outside-link/secret.txt", displayName: "secret.txt" }];
  assert.throws(() => validateTurnAttachments("user", workspace, attachments), /不属于当前工作区/);
});

test("plain text does not resolve attachment paths", () => {
  validateTurnAttachments("user", "missing-workspace");
  validateTurnAttachments("user", "missing-workspace", []);
});

test("stores regular uploads under their owner with UUIDs and safe extensions", () => {
  const file = storeUploadedFile("file-owner", Buffer.from("hello"), "C:\\fakepath\\项目计划.TXT");
  assert.match(file.fileId, /^[a-f0-9-]{36}\.txt$/);
  assert.equal(file.path, path.join(uploadDirectory("file-owner"), file.fileId));
  assert.equal(file.displayName, "项目计划.TXT");
  assert.equal(fs.readFileSync(file.path, "utf8"), "hello");
  const unsafe = storeUploadedFile("file-owner", Buffer.from("hello"), "../../report.bad-ext");
  assert.match(unsafe.fileId, /\.bin$/);
  assert.equal(unsafe.displayName, "report.bad-ext");
});

test("enforces the 20 MB file boundary and shared image/file quota", () => {
  assert.throws(() => storeUploadedFile("limits", Buffer.alloc(0), "empty.txt"), /内容为空/);
  assert.throws(() => storeUploadedFile("limits", Buffer.alloc(MAX_FILE_SIZE + 1), "large.txt"), /20 MB/);
  const max = storeUploadedFile("limits", Buffer.alloc(MAX_FILE_SIZE), "max.txt");
  assert.equal(fs.statSync(max.path).size, MAX_FILE_SIZE);
  fs.truncateSync(max.path, MAX_USER_UPLOADS_SIZE);
  assert.throws(() => storeUploadedFile("limits", Buffer.from("x"), "next.txt"), /200 MB/);
  assert.throws(() => storeUploadedImage("limits", png, "image/png", "next.png"), /200 MB/);
});

test("keeps supported images on the original upload API", () => {
  assert.throws(() => storeUploadedFile("images", png, "renamed.txt"), /图片上传接口/);
  assert.throws(() => storeUploadedFile("images", Buffer.from("fake"), "photo.jpg"), /图片上传接口/);
  const image = storeUploadedImage("images", png, "image/png", "photo.png");
  assert.deepEqual(readStoredImage("images", image.imageId), png);
  validateTurnAttachments("images", "missing-workspace", [image]);
});

test("uploaded IDs require the current owner and exact stored path without workspace fallback", (t) => {
  const { workspace } = fixture(t);
  const file = storeUploadedFile("alice", Buffer.from("private"), "private.txt");
  validateTurnAttachments("alice", "missing-workspace", [file]);
  assert.throws(() => validateTurnAttachments("bob", workspace, [file]), /不属于当前用户/);
  assert.throws(() => validateTurnAttachments("alice", workspace, [{ ...file, path: "src/inside.ts" }]), /不属于当前用户/);
  assert.throws(() => validateTurnAttachments("alice", workspace, [{ path: "src/inside.ts", fileId: "" }]), /文件标识无效/);
  assert.throws(() => validateTurnAttachments("alice", workspace, [{ ...file, fileId: "../private.txt" }]), /文件标识无效/);
  assert.throws(() => validateTurnAttachments("alice", workspace, [{ ...file, imageId: "a.png" }]), /附件标识无效/);
  const missing = { ...file, fileId: "00000000-0000-0000-0000-000000000000.txt",
    path: path.join(uploadDirectory("alice"), "00000000-0000-0000-0000-000000000000.txt") };
  assert.throws(() => validateTurnAttachments("alice", workspace, [missing]), /不属于当前用户/);
  const directory = storeUploadedFile("alice", Buffer.from("x"), "directory.txt");
  fs.unlinkSync(directory.path);
  fs.mkdirSync(directory.path);
  assert.throws(() => validateTurnAttachments("alice", workspace, [directory]), /不属于当前用户/);
});

test("rejects uploaded files whose user directory redirects to another owner", (t) => {
  const file = storeUploadedFile("real-owner", Buffer.from("secret"), "secret.txt");
  const link = uploadDirectory("linked-owner");
  try {
    fs.symlinkSync(uploadDirectory("real-owner"), link, "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("当前环境不允许创建符号链接");
    throw error;
  }
  assert.throws(() => validateTurnAttachments("linked-owner", "missing-workspace", [
    { ...file, path: path.join(link, file.fileId) },
  ]), /不属于当前用户/);
  assert.throws(() => storeUploadedFile("linked-owner", Buffer.from("x"), "x.txt"), /上传目录无效/);
});

test("failure and thread cleanup handle images and files using the recorded owner", () => {
  const file = storeUploadedFile("cleanup", Buffer.from("x"), "file.txt");
  const image = storeUploadedImage("cleanup", png, "image/png", "image.png");
  removeUploadedImages("cleanup", [file, image]);
  assert.equal(fs.existsSync(file.path), false);
  assert.equal(fs.existsSync(image.path), false);
  const collaborator = storeUploadedFile("collaborator", Buffer.from("x"), "shared.txt");
  removeThreadUploads({ ...thread(), messageAttachments: { message: [
    { id: collaborator.fileId, kind: "file", ownerId: "collaborator", displayName: "shared.txt" },
  ] } });
  assert.equal(fs.existsSync(collaborator.path), false);
});

test("failed turns and rejected validation remove drafts while preserving historical uploads", async (t) => {
  const { workspace } = fixture(t);
  const previousThreads = store.threads;
  const previousProjects = store.projects;
  t.after(() => { store.threads = previousThreads; store.projects = previousProjects; });
  const saved = storeUploadedFile("owner", Buffer.from("history"), "saved.txt");
  const savedImage = storeUploadedImage("owner", png, "image/png", "saved.png");
  const history = { ...thread(), messageAttachments: { old: [
    { id: saved.fileId, displayName: "saved.txt", kind: "file" as const, ownerId: "owner" },
    { id: savedImage.imageId, displayName: "saved.png", kind: "image" as const, ownerId: "owner" },
  ] } };
  store.threads = [history];
  store.projects = [{ id: "project", name: "Project", ownerId: "owner", path: workspace }];
  const { Hub } = await import("./hub.js");
  let sent = 0;
  const hub = Object.assign(Object.create(Hub.prototype), { provisionalThreads: new Map(), manager: {
    sendMessage: async () => { sent += 1; throw new Error("engine rejected"); },
  } }) as { onMessage(conn: unknown, raw: string): Promise<void>; cleanupInitialTurnUploads(conn: unknown, turn: unknown): void };
  const replies: { ok: boolean; error?: string }[] = [];
  const conn = { user: { username: "owner", role: "user" }, socket: {
    readyState: 1, OPEN: 1, send: (raw: string) => replies.push(JSON.parse(raw)),
  } };
  const draft = storeUploadedFile("owner", Buffer.from("draft"), "draft.txt");
  const draftImage = storeUploadedImage("owner", png, "image/png", "draft.png");
  await hub.onMessage(conn, JSON.stringify({ type: "turn.start", id: "failed", threadId: history.id,
    text: "send", attachments: [saved, savedImage, draft, draftImage] }));
  assert.equal(sent, 1);
  assert.equal(replies.at(-1)?.error, "engine rejected");
  assert.equal(fs.existsSync(draft.path), false);
  assert.equal(fs.existsSync(draftImage.path), false);
  assert.equal(fs.existsSync(saved.path), true);
  assert.equal(fs.existsSync(savedImage.path), true);
  const invalidDraft = storeUploadedFile("owner", Buffer.from("draft"), "invalid.txt");
  await hub.onMessage(conn, JSON.stringify({ type: "turn.start", id: "invalid", threadId: history.id,
    text: "send", attachments: [saved, { ...invalidDraft, path: "src/inside.ts" }] }));
  assert.equal(sent, 1);
  assert.equal(replies.at(-1)?.ok, false);
  assert.equal(fs.existsSync(invalidDraft.path), false);
  assert.equal(fs.existsSync(saved.path), true);
  const deniedDraft = storeUploadedFile("owner", Buffer.from("draft"), "denied.txt");
  await hub.onMessage(conn, JSON.stringify({ type: "turn.start", id: "denied", threadId: "unavailable-thread",
    text: "send", attachments: [saved, deniedDraft] }));
  assert.equal(sent, 1);
  assert.equal(replies.at(-1)?.ok, false);
  assert.equal(fs.existsSync(deniedDraft.path), false);
  assert.equal(fs.existsSync(saved.path), true);
  const initialDraft = storeUploadedFile("owner", Buffer.from("draft"), "initial.txt");
  hub.cleanupInitialTurnUploads(conn, { attachments: [saved, savedImage, initialDraft] });
  assert.equal(fs.existsSync(initialDraft.path), false);
  assert.equal(fs.existsSync(saved.path), true);
  assert.equal(fs.existsSync(savedImage.path), true);
  removeThreadUploads(history, [{ ...history, id: "another-thread" }]);
  assert.equal(fs.existsSync(saved.path), true);
  assert.equal(fs.existsSync(savedImage.path), true);
});

function thread(): ThreadMeta {
  return { id: "download-thread", projectId: "project", title: "Thread", userId: "owner",
    createdAt: 1, updatedAt: 1, archived: false };
}

async function routes(t: TestContext) {
  const previousThreads = store.threads;
  store.threads = [];
  const app = Fastify();
  registerUploadRoutes(app, (header) => header?.startsWith("Bearer ")
    ? { username: header.slice(7), role: header === "Bearer admin" ? "admin" : "user" } : null);
  t.after(async () => { await app.close(); store.threads = previousThreads; });
  return app;
}

test("raw upload endpoint handles names, content types and request size limits", async (t) => {
  const app = await routes(t);
  const headers = { authorization: "Bearer owner", "content-type": "application/octet-stream", "x-file-name": encodeURIComponent("报告.txt") };
  const response = await app.inject({ method: "POST", url: "/api/uploads/files", headers, payload: Buffer.alloc(2 * 1024 * 1024, "x") });
  assert.equal(response.statusCode, 200, response.body);
  const result = response.json();
  assert.equal(result.displayName, "报告.txt");
  assert.equal(result.path, path.join(uploadDirectory("owner"), result.id));
  assert.equal(fs.statSync(result.path).size, 2 * 1024 * 1024);
  const max = await app.inject({ method: "POST", url: "/api/uploads/files", headers, payload: Buffer.alloc(MAX_FILE_SIZE, "x") });
  assert.equal(max.statusCode, 200, max.body);
  const tooLarge = await app.inject({ method: "POST", url: "/api/uploads/files", headers, payload: Buffer.alloc(MAX_FILE_SIZE + 1) });
  assert.equal(tooLarge.statusCode, 413);
  const invalid = await app.inject({ method: "POST", url: "/api/uploads/files", headers: { ...headers, "x-file-name": "%broken" }, payload: "x" });
  assert.equal(invalid.statusCode, 400);
  const missingName = await app.inject({ method: "POST", url: "/api/uploads/files", headers: { authorization: "Bearer owner", "content-type": "application/octet-stream" }, payload: "x" });
  assert.equal(missingName.statusCode, 400);
  const wrongType = await app.inject({ method: "POST", url: "/api/uploads/files", headers: { ...headers, "content-type": "text/plain" }, payload: "x" });
  assert.equal(wrongType.statusCode, 415);
  const anonymous = await app.inject({ method: "POST", url: "/api/uploads/files", headers: { "content-type": "application/octet-stream" }, payload: "x" });
  assert.equal(anonymous.statusCode, 401);
});

test("downloads require thread access or a valid share token and preserve collaborator ownership", async (t) => {
  const app = await routes(t);
  const file = storeUploadedFile("uploader", Buffer.from("download me"), '报告"\r\n.txt');
  store.threads = [{ ...thread(), messageAttachments: { message: [
    { id: file.fileId, kind: "file", ownerId: "uploader", displayName: file.displayName! },
  ] } }];
  const url = `/api/uploads/files/${file.fileId}?threadId=download-thread`;
  const own = await app.inject({ url, headers: { authorization: "Bearer owner" } });
  assert.equal(own.statusCode, 200, own.body);
  assert.equal(own.body, "download me");
  assert.equal(own.headers["content-type"], "application/octet-stream");
  assert.match(String(own.headers["content-disposition"]), /^attachment;.*filename\*=UTF-8''/);
  assert.ok(String(own.headers["content-disposition"]).includes(encodeURIComponent('报告".txt')));
  for (const username of ["uploader", "outsider", "admin"]) {
    assert.equal((await app.inject({ url, headers: { authorization: `Bearer ${username}` } })).statusCode, 403);
  }
  assert.equal((await app.inject({ url })).statusCode, 401);
  const share = await shares.createThreadShare("download-thread", "readonly", "owner");
  const shared = await app.inject({ url: `${url}&shareToken=${share.token}`, headers: { authorization: "Bearer reader" } });
  assert.equal(shared.statusCode, 200, shared.body);
  const bad = await app.inject({ url, headers: { authorization: "Bearer reader", "x-thread-share-token": "wrong" } });
  assert.equal(bad.statusCode, 403);
  const headerToken = await app.inject({ url, headers: { authorization: "Bearer reader", "x-thread-share-token": share.token } });
  assert.equal(headerToken.statusCode, 200);
  await shares.redeemThreadShare(share.token, "member");
  assert.equal((await app.inject({ url, headers: { authorization: "Bearer member" } })).statusCode, 200);
  await shares.revokeThreadShare("download-thread");
  assert.equal((await app.inject({ url: `${url}&shareToken=${share.token}`, headers: { authorization: "Bearer reader" } })).statusCode, 403);
  const unreferenced = storeUploadedFile("uploader", Buffer.from("private"), "unreferenced.txt");
  assert.equal((await app.inject({ url: `/api/uploads/files/${unreferenced.fileId}?threadId=download-thread`, headers: { authorization: "Bearer owner" } })).statusCode, 404);
});

test("draft deletion checks ownership and refuses attachments referenced by any thread", async (t) => {
  const app = await routes(t);
  for (const kind of ["image", "file"] as const) {
    const stored = kind === "image" ? storeUploadedImage("draft-owner", png, "image/png", "image.png")
      : storeUploadedFile("draft-owner", Buffer.from("x"), "draft.txt");
    const id = stored.imageId ?? stored.fileId!;
    const url = `/api/uploads/${kind}s/${id}`;
    assert.equal((await app.inject({ method: "DELETE", url, headers: { authorization: "Bearer other" } })).statusCode, 404);
    store.threads = [{ ...thread(), messageAttachments: { message: [
      { id, kind, ownerId: "draft-owner", displayName: "attachment" },
    ] } }];
    assert.equal((await app.inject({ method: "DELETE", url, headers: { authorization: "Bearer draft-owner" } })).statusCode, 409);
    assert.equal(fs.existsSync(stored.path), true);
    store.threads = [];
    assert.equal((await app.inject({ method: "DELETE", url, headers: { authorization: "Bearer draft-owner" } })).statusCode, 204);
    assert.equal(fs.existsSync(stored.path), false);
  }
});
