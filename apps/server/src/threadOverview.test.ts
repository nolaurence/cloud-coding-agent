import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateThreadOverview } from "./threadOverview.js";

test("overview annotations trim and retain source references without accepting extra fields", () => {
  assert.deepEqual(validateThreadOverview({ goal: "  完成开发  ", notes: [{ id: "note-1", text: "  不改协议  ", pinned: true, sourceTurnId: "turn-1", unexpected: true }], unexpected: true }), {
    goal: "完成开发", notes: [{ id: "note-1", text: "不改协议", pinned: true, sourceTurnId: "turn-1" }],
  });
  assert.deepEqual(validateThreadOverview({ goal: " ", notes: [] }), { notes: [] });
});

test("overview annotations reject oversized, malformed and duplicate notes", () => {
  const note = { id: "same", text: "decision", pinned: true };
  for (const input of [null, [], {}, { notes: "invalid" }, { notes: [note, note] }, { notes: [{ ...note, text: " " }] },
    { notes: [{ ...note, pinned: "true" }] }, { notes: [{ ...note, sourceTurnId: {} }] },
    { notes: [], goal: "x".repeat(4001) }, { notes: Array.from({ length: 51 }, (_, index) => ({ ...note, id: String(index) })) }]) {
    assert.throws(() => validateThreadOverview(input));
  }
});

test("overview mutations persist for owners and resource requests reject other users", async (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cca-overview-"));
  const previous = process.env.CCA_DATA_DIR;
  process.env.CCA_DATA_DIR = directory;
  context.after(() => {
    if (previous === undefined) delete process.env.CCA_DATA_DIR;
    else process.env.CCA_DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const { Hub } = await import("./hub.js");
  const { store } = await import("./store.js");
  const originalThreads = store.threads;
  context.after(() => { store.threads = originalThreads; });
  const thread = { id: "owned-thread", projectId: "project", userId: "owner", title: "test", createdAt: 1, updatedAt: 1, archived: false };
  store.threads = [thread];
  const replies: { ok?: boolean; error?: string }[] = [];
  const hub = Object.create(Hub.prototype) as {
    provisionalThreads: Map<string, unknown>;
    send(connection: unknown, response: unknown): void;
    broadcastShell(): void;
    onMessage(connection: unknown, message: string): Promise<void>;
  };
  hub.send = (_connection, response) => replies.push(response as typeof replies[number]);
  hub.broadcastShell = () => {};
  hub.provisionalThreads = new Map();
  const owner = { user: { username: "owner", role: "user" } };
  const other = { user: { username: "other", role: "user" } };
  const overview = { goal: "新目标", notes: [{ id: "note-1", text: "保持兼容", pinned: true }] };
  await hub.onMessage(other, JSON.stringify({ id: "1", type: "thread.overview.update", threadId: thread.id, overview }));
  assert.equal(replies.pop()?.ok, false);
  assert.equal(store.getThread(thread.id)?.overview, undefined);
  await hub.onMessage(owner, JSON.stringify({ id: "2", type: "thread.overview.update", threadId: thread.id, overview }));
  const savedReply = replies.pop();
  assert.equal(savedReply?.ok, true, savedReply?.error);
  assert.deepEqual(store.getThread(thread.id)?.overview, overview);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, "threads.json"), "utf8"))[0].overview, overview);
  await hub.onMessage(other, JSON.stringify({ id: "3", type: "runtime.resources", threadId: thread.id }));
  assert.match(replies.pop()?.error ?? "", /无权/);
  await hub.onMessage(owner, JSON.stringify({ id: "4", type: "thread.overview.update", threadId: thread.id, overview: { notes: "bad" } }));
  assert.equal(replies.pop()?.ok, false);
  assert.deepEqual(store.getThread(thread.id)?.overview, overview);
});
