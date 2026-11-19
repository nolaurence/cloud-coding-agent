import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { MessageId, freezeMessage } from "@deepseek-ai/dsh-llm";
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from "@deepseek-ai/dsh-session";
import * as JsonlPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { forkedThreadTitle, normalizeThreadTitle, THREAD_TITLE_MAX_LENGTH } from "@cca/protocol";
import {
  copySessionHome,
  forkDshNativeSession,
  rewriteDshSessionIdentity,
  rewriteSessionIdentityText,
} from "./sessionFork.js";

test("normalizes session titles and builds fork titles", () => {
  assert.equal(normalizeThreadTitle("  修复侧栏  "), "修复侧栏");
  assert.equal(forkedThreadTitle("修复侧栏"), "修复侧栏（分叉）");
  assert.equal(forkedThreadTitle("  "), "新会话（分叉）");
  const long = "标".repeat(THREAD_TITLE_MAX_LENGTH);
  assert.equal(forkedThreadTitle(long).length, THREAD_TITLE_MAX_LENGTH);
  assert.ok(forkedThreadTitle(long).endsWith("（分叉）"));
  assert.throws(() => normalizeThreadTitle(""), /不能为空/);
  assert.throws(() => normalizeThreadTitle("x".repeat(THREAD_TITLE_MAX_LENGTH + 1)), /80/);
});

test("copies an isolated Codex home without rewriting the native thread id", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-codex-fork-"));
  try {
    const sourceId = randomUUID();
    const destId = randomUUID();
    const nativeId = "codex-native-thread";
    const source = path.join(root, sourceId);
    fs.mkdirSync(path.join(source, "sessions", "2026", "01"), { recursive: true });
    fs.writeFileSync(
      path.join(source, "cca-thread.json"),
      JSON.stringify({ threadId: nativeId, cwd: "/workspace" }),
    );
    fs.writeFileSync(
      path.join(source, "cca-events.jsonl"),
      `${JSON.stringify({ id: "evt-1", type: "user.message", data: { content: "hi" } })}\n`,
    );
    fs.writeFileSync(path.join(source, "sessions", "2026", "01", `${nativeId}.jsonl`), "{\"thread\":\"ok\"}\n");
    copySessionHome(source, path.join(root, destId));
    const dest = path.join(root, destId);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(dest, "cca-thread.json"), "utf8")),
      { threadId: nativeId, cwd: "/workspace" },
    );
    assert.match(fs.readFileSync(path.join(dest, "cca-events.jsonl"), "utf8"), /evt-1/);
    assert.equal(
      fs.readFileSync(path.join(dest, "sessions", "2026", "01", `${nativeId}.jsonl`), "utf8"),
      "{\"thread\":\"ok\"}\n",
    );
    copySessionHome(path.join(root, "missing"), path.join(root, "nope"));
    assert.equal(fs.existsSync(path.join(root, "nope")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rewrites DSH session identity in directories, mapping, cache and native jsonl", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cca-dsh-fork-"));
  const sourceId = randomUUID();
  const destId = randomUUID();
  const workspace = path.join(home, "workspace");
  fs.mkdirSync(workspace);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(home, "cca-thread.json"),
    JSON.stringify({ threadId: sourceId, cwd: workspace }),
  );
  fs.writeFileSync(
    path.join(home, "cca-events.jsonl"),
    `${JSON.stringify({ id: "evt-keep", type: "user.message", data: { content: "continue from here" } })}\n`,
  );
  const cacheDir = path.join(home, "storages", "session_projcache", "sessions");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, `${sourceId}.json`),
    JSON.stringify({ record: { rows: { id: sourceId } } }),
  );

  const writer = new Context();
  t.after(() => writer.fiber.dispose());
  await writer.plugin(JsonlPersistence, { root: path.join(home, "sessions") });
  const handle = await writer.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION,
    id: SessionId(sourceId),
    createdAt: 1000,
    cwd: workspace,
    isSeeded: false,
  });
  try {
    await handle.append([
      { type: "turn/start", seq: SessionSeq(0), time: 1000, data: { turn: 1 } },
      {
        type: "user/message",
        seq: SessionSeq(1),
        time: 1010,
        surfaceOp: "append",
        data: freezeMessage({
          id: MessageId("fixture-user"),
          role: "user",
          content: [{ type: "text", text: "continue from here" }],
          source: { kind: "user" },
        }),
      },
    ]);
    await handle.flush();
  } finally {
    await handle.close();
  }

  const copied = path.join(path.dirname(home), `copied-${destId}`);
  copySessionHome(home, copied);
  rewriteDshSessionIdentity(copied, sourceId, destId);
  await forkDshNativeSession(copied, sourceId, destId);

  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(copied, "cca-thread.json"), "utf8")),
    { threadId: destId, cwd: workspace },
  );
  assert.equal(fs.existsSync(path.join(copied, "storages", "session_projcache", "sessions", `${destId}.json`)), true);
  assert.equal(fs.existsSync(path.join(copied, "storages", "session_projcache", "sessions", `${sourceId}.json`)), false);
  const events = fs.readFileSync(path.join(copied, "cca-events.jsonl"), "utf8");
  assert.ok(events.includes("evt-keep"));
  assert.ok(events.includes("continue from here"));
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(copied, "storages", "session_projcache", "sessions", `${destId}.json`), "utf8")),
    { record: { rows: { id: destId } } },
  );

  const reader = new Context();
  t.after(() => reader.fiber.dispose());
  await reader.plugin(JsonlPersistence, { root: path.join(copied, "sessions") });
  assert.ok(!(await reader.sessionPersistence.stat(SessionId(sourceId))));
  assert.ok(await reader.sessionPersistence.stat(SessionId(destId)));
  const opened = await reader.sessionPersistence.open(SessionId(destId), "read");
  try {
    const record = await opened.read();
    assert.equal(record.events.length, 2);
    assert.equal(record.events[1]?.type, "user/message");
  } finally {
    await opened.close();
  }
});

test("identity rewrite only replaces standalone session ids", () => {
  const sourceId = "abc-123";
  const destId = "xyz-789";
  assert.equal(rewriteSessionIdentityText(sourceId, sourceId, destId), destId);
  assert.equal(
    rewriteSessionIdentityText(`/sessions/ws/${sourceId}/log`, sourceId, destId),
    `/sessions/ws/${destId}/log`,
  );
  assert.equal(rewriteSessionIdentityText(`prefix${sourceId}`, sourceId, destId), `prefix${sourceId}`);
});
