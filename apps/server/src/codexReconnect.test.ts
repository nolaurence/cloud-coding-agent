import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { CODEX_RECONNECT_DELAYS_MS, retryCodexReconnect } from "./codexReconnect.js";

test("Codex reconnect retries five times with Codex delays", async () => {
  const attempts: number[] = [];
  const delays: number[] = [];
  await assert.rejects(
    retryCodexReconnect(async (attempt) => {
      attempts.push(attempt);
      throw new Error("failure " + attempt);
    }, { sleep: async (delay) => { delays.push(delay); } }),
    /failure 4/,
  );
  assert.deepEqual(attempts, [0, 1, 2, 3, 4]);
  assert.deepEqual(delays, [...CODEX_RECONNECT_DELAYS_MS]);
});

test("Codex reconnect stops after a successful attempt", async () => {
  const attempts: number[] = [];
  const delays: number[] = [];
  const result = await retryCodexReconnect(async (attempt) => {
    attempts.push(attempt);
    if (attempt < 2) throw new Error("retry");
    return "connected";
  }, { sleep: async (delay) => { delays.push(delay); } });
  assert.equal(result, "connected");
  assert.deepEqual(attempts, [0, 1, 2]);
  assert.deepEqual(delays, [...CODEX_RECONNECT_DELAYS_MS.slice(0, 3)]);
});

test("CodexSession resumes the same thread after app-server exits", { timeout: 30_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".codex-reconnect-test-"));
  const workspace = path.join(root, "workspace");
  const state = path.join(root, "spawns.log");
  const fakeCodex = path.join(root, "fake-codex.mjs");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline";

const state = ${JSON.stringify(state)};
fs.appendFileSync(state, "spawn\\n");
const spawn = fs.readFileSync(state, "utf8").trim().split("\\n").length;
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    return send({ id: message.id, result: { thread: { id: "fake-thread" } } });
  }
  if (message.method !== "turn/start") return;
  const turnId = "turn-" + spawn;
  send({ id: message.id, result: { turn: { id: turnId } } });
  send({ method: "turn/started", params: { threadId: "fake-thread", turn: { id: turnId } } });
  if (spawn === 1) return setTimeout(() => process.exit(1), 20);
  send({ method: "item/completed", params: { threadId: "fake-thread", item: { id: "item-" + spawn, type: "agentMessage", text: "reconnected" } } });
  send({ method: "turn/completed", params: { threadId: "fake-thread", turn: { id: turnId, status: "completed" } } });
});
`, { mode: 0o755 });
  const previous = {
    data: process.env.CCA_DATA_DIR,
    workspace: process.env.WORKSPACE_ROOT,
    codex: process.env.CCA_CODEX_PATH,
  };
  process.env.CCA_DATA_DIR = path.join(root, "data");
  process.env.WORKSPACE_ROOT = workspace;
  process.env.CCA_CODEX_PATH = fakeCodex;
  const { CodexClient } = await import("./codex.js");
  const client = new CodexClient();
  await client.start();
  const session = await client.createSession({ sessionId: randomUUID(), workingDirectory: workspace, model: "gpt-5.4" });
  t.after(async () => {
    await session.disconnect().catch(() => {});
    await client.stop();
    if (previous.data === undefined) delete process.env.CCA_DATA_DIR;
    else process.env.CCA_DATA_DIR = previous.data;
    if (previous.workspace === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = previous.workspace;
    if (previous.codex === undefined) delete process.env.CCA_CODEX_PATH;
    else process.env.CCA_CODEX_PATH = previous.codex;
    fs.rmSync(root, { recursive: true, force: true });
  });

  await assert.rejects(session.sendAndWait("crash", 5_000), /连接中断/);
  assert.equal(session.runtimeDisconnected, false);
  const response = await session.sendAndWait("after reconnect", 15_000);
  assert.equal(response?.data.content, "reconnected");
  assert.equal(fs.readFileSync(state, "utf8").trim().split("\n").length, 2);
});
