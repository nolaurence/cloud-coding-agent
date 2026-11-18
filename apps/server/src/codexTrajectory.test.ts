import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { SessionEvent } from "@github/copilot-sdk";
import { TrajectoryProjector } from "@cca/dsh-ui-trajectory/projector";

function journalEvent(type: string, data: unknown, at: number, id: string): SessionEvent {
  // 只用于构造测试夹具;Codex 运行时写入的日志带有完整的 copilot-sdk 事件信封
  return { id, parentId: null, timestamp: new Date(at).toISOString(), type, data } as unknown as SessionEvent;
}

const journalLines: SessionEvent[] = [
  journalEvent("user.message", { content: "列出仓库文件" }, 1_000, "e1"),
  journalEvent("assistant.turn_start", { turnId: "turn-1" }, 1_010, "e2"),
  journalEvent("tool.execution_start", { toolCallId: "reasoning:i1", toolName: "reasoning", arguments: {} }, 1_020, "e3"),
  journalEvent("tool.execution_complete", { toolCallId: "reasoning:i1", success: true, result: { content: "先看根目录" } }, 1_030, "e4"),
  journalEvent("assistant.message", { messageId: "m1", content: "好的,我来看看", model: "gpt-5.1" }, 1_100, "e5"),
  journalEvent("tool.execution_start", { toolCallId: "c1", toolName: "bash", arguments: { command: "ls" } }, 1_110, "e6"),
  journalEvent("tool.execution_complete", { toolCallId: "c1", success: true, result: { content: "README.md" } }, 1_200, "e7"),
  journalEvent("session.idle", { aborted: false }, 1_300, "e8"),
];

test("codex trajectory reads the durable journal into DSH-shaped pages", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cca-codex-trajectory-"));
  const previous = process.env.CCA_DATA_DIR;
  process.env.CCA_DATA_DIR = directory;
  const { readCodexTrajectory } = await import("./codexTrajectory.js");
  const threadId = "codex-trajectory-test";
  const home = path.join(directory, "codex-home", threadId);
  fs.mkdirSync(home, { recursive: true });
  const journal = path.join(home, "cca-events.jsonl");
  fs.writeFileSync(journal, journalLines.map(event => JSON.stringify(event)).join("\n") + "\n");
  t.after(() => {
    if (previous === undefined) delete process.env.CCA_DATA_DIR;
    else process.env.CCA_DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const page = await readCodexTrajectory(threadId);
  assert.deepEqual(page.events.map(event => event.type), [
    "turn/start", "user/message",
    "tool/call", "tool/result",
    "step/start", "assistant/message",
    "tool/call", "tool/result",
    "step/end", "turn/end",
  ]);
  assert.deepEqual(page.events.map(event => event.seq), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(page.hasMoreBefore, false);
  assert.equal(page.hasMoreAfter, false);
  assert.equal(page.events[0]?.time, 1_000);
  assert.deepEqual(page.events[1]?.data, {
    id: "e1", role: "user", content: [{ type: "text", text: "列出仓库文件" }], source: { kind: "user" },
  });
  assert.deepEqual(page.events[2]?.data, {
    turn: 1, step: 1, callId: "reasoning:i1", name: "reasoning", arguments: "{}",
  });
  assert.deepEqual(page.events[3]?.data, {
    turn: 1,
    step: 1,
    message: {
      id: "e4",
      role: "tool",
      content: [{ type: "text", text: "先看根目录" }],
      source: { kind: "tool", callId: "reasoning:i1" },
      toolCallId: "reasoning:i1",
      isError: false,
    },
  });
  assert.deepEqual(page.events[4]?.data, { turn: 1, step: 1 });
  assert.deepEqual(page.events[5]?.data, {
    turn: 1,
    step: 1,
    message: {
      id: "m1",
      role: "assistant",
      content: [{ type: "text", text: "好的,我来看看" }],
      source: { kind: "model", provider: "codex", model: "gpt-5.1" },
    },
    stream: [],
  });
  assert.deepEqual(page.events[6]?.data, {
    turn: 1, step: 1, callId: "c1", name: "bash", arguments: '{"command":"ls"}',
  });
  assert.deepEqual(page.events[7]?.data, {
    turn: 1,
    step: 1,
    message: {
      id: "e7",
      role: "tool",
      content: [{ type: "text", text: "README.md" }],
      source: { kind: "tool", callId: "c1" },
      toolCallId: "c1",
      isError: false,
    },
  });
  assert.deepEqual(page.events[9]?.data, { turn: 1, reason: { kind: "completed" } });

  const first = await readCodexTrajectory(threadId, { afterSeq: -1, limit: 2 });
  assert.deepEqual(first.events.map(event => event.seq), [0, 1]);
  assert.equal(first.hasMoreAfter, true);
  const tail = await readCodexTrajectory(threadId, { limit: 3 });
  assert.deepEqual(tail.events.map(event => event.seq), [7, 8, 9]);
  assert.equal(tail.hasMoreBefore, true);
  const older = await readCodexTrajectory(threadId, { beforeSeq: 4, limit: 2 });
  assert.deepEqual(older.events.map(event => event.seq), [2, 3]);
  const unchanged = await readCodexTrajectory(threadId, { afterSeq: 9, knownRevision: page.revision });
  assert.equal(unchanged.unchanged, true);
  assert.deepEqual(unchanged.events, []);

  // 追加一条 user.message 后 revision 必须变化,轮询才能取到增量
  fs.appendFileSync(journal, "\n" + JSON.stringify(journalEvent("user.message", { content: "继续" }, 1_400, "e9")));
  const grown = await readCodexTrajectory(threadId, { afterSeq: 9, knownRevision: page.revision });
  assert.equal(grown.unchanged, undefined);
  assert.deepEqual(grown.events.map(event => event.type), ["turn/start", "user/message"]);
  assert.deepEqual(grown.events.map(event => event.seq), [10, 11]);

  // 第二轮没有收到 idle 就来了新的 user.message:按 interrupted 收尾,回合不粘连
  fs.appendFileSync(journal, "\n" + [
    journalEvent("tool.execution_start", { toolCallId: "c2", toolName: "bash", arguments: { command: "pwd" } }, 1_410, "e10"),
    journalEvent("tool.execution_complete", { toolCallId: "c2", success: true, result: { content: "/repo" } }, 1_500, "e11"),
    journalEvent("user.message", { content: "再试一次" }, 1_600, "e12"),
    journalEvent("session.idle", { aborted: true }, 1_700, "e13"),
  ].map(event => JSON.stringify(event)).join("\n") + "\n");
  const resumed = await readCodexTrajectory(threadId);
  assert.deepEqual(resumed.events.map(event => event.type), [
    "turn/start", "user/message",
    "tool/call", "tool/result",
    "step/start", "assistant/message",
    "tool/call", "tool/result",
    "step/end", "turn/end",
    "turn/start", "user/message",
    "tool/call", "tool/result",
    "turn/end",
    "turn/start", "user/message",
    "turn/end",
  ]);
  assert.deepEqual(resumed.events[14]?.data, { turn: 2, reason: { kind: "interrupted" } });
  assert.deepEqual(resumed.events[17]?.data, { turn: 3, reason: { kind: "aborted", reason: { kind: "user" } } });

  assert.deepEqual((await readCodexTrajectory("empty-thread")).events, []);
  await assert.rejects(() => readCodexTrajectory("../outside"), /会话标识/);
  await assert.rejects(() => readCodexTrajectory(threadId, { limit: 0 }), /页大小/);
  await assert.rejects(() => readCodexTrajectory(threadId, { beforeSeq: 1, afterSeq: 0 }), /同时/);
});

test("projected codex events assemble in the vendored trajectory projector", async () => {
  const { projectCodexTrajectoryEvents } = await import("./codexTrajectory.js");
  const snapshot = new TrajectoryProjector().update(projectCodexTrajectoryEvents(journalLines), false);
  const assistant = snapshot.eventNodes.find(node => node.kind === "assistant");
  assert.equal(assistant?.timing?.stepStartTime, 1_030);
  assert.equal(assistant?.timing?.completedTime, 1_100);
  assert.equal(assistant?.providerMetadata?.model, "gpt-5.1");
  assert.equal(snapshot.requests[0]?.status, "complete");
  assert.equal(snapshot.requests[0]?.startedAt, 1_030);
  assert.equal(snapshot.requests[0]?.completedAt, 1_100);
  assert.deepEqual(
    snapshot.eventNodes.filter(node => node.kind === "tool-result").map(node => node.name),
    ["reasoning", "bash"],
  );
  const tool = snapshot.eventNodes.filter(node => node.kind === "tool-result").find(node => node.name === "bash");
  assert.equal(tool?.call?.argsRaw, '{"command":"ls"}');
  assert.deepEqual(tool?.content, [{ type: "text", text: "README.md" }]);
  assert.equal(snapshot.eventNodes.some(node => node.kind === "user"), true);
});
