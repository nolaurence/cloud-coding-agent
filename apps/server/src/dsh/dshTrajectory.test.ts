import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { MessageId, freezeMessage } from "@deepseek-ai/dsh-llm";
import { SessionId, SessionSeq, SESSION_FORMAT_VERSION, type SessionEvent } from "@deepseek-ai/dsh-session";
import * as JsonlPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import { TrajectoryProjector, type TrajectoryEvent } from "@cca/dsh-ui-trajectory/projector";

const events: SessionEvent[] = [
  { type: "turn/start", seq: SessionSeq(0), time: 1000, data: { turn: 1 } },
  { type: "user/message", seq: SessionSeq(1), time: 1010, surfaceOp: "append", data: freezeMessage({
    id: MessageId("fixture-user"), role: "user", content: [{ type: "text", text: "hi" }], source: { kind: "user" },
  }) },
  { type: "step/start", seq: SessionSeq(2), time: 1050, data: { turn: 1, step: 1 } },
  { type: "assistant/message", seq: SessionSeq(3), time: 1200, surfaceOp: "append", data: {
    turn: 1, step: 1,
    message: freezeMessage({ id: MessageId("fixture-assistant"), role: "assistant", content: [{ type: "text", text: "hello world" }], source: { kind: "model", provider: "mock", model: "mock" } }),
    stream: [
      { type: "chunk", time: 1060, chunk: { type: "block-start", index: 0, blockType: "text" } },
      { type: "text-chunks", time0: 1100, index: 0, dt: [40], texts: ["hello ", "world"] },
      { type: "chunk", time: 1200, chunk: { type: "block-end", index: 0, block: { type: "text", text: "hello world" } } },
      { type: "chunk", time: 1200, chunk: { type: "finish", reason: { kind: "stop" } } },
    ],
  } },
  { type: "step/end", seq: SessionSeq(4), time: 1250, data: { turn: 1, step: 1 } },
  { type: "turn/end", seq: SessionSeq(5), time: 1300, data: { turn: 1, reason: { kind: "completed" } } },
];

test("native trajectory reads compressed history while its writer is open and after restart", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cca-native-trajectory-"));
  const previous = process.env.CCA_DATA_DIR;
  process.env.CCA_DATA_DIR = directory;
  const { readDshTrajectory } = await import("./dshTrajectory.js");
  const threadId = "trajectory-test";
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace);
  const writer = new Context();
  t.after(async () => {
    await writer.fiber.dispose();
    if (previous === undefined) delete process.env.CCA_DATA_DIR;
    else process.env.CCA_DATA_DIR = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await writer.plugin(JsonlPersistence, { root: path.join(directory, "dsh-home", threadId, "sessions") });
  const handle = await writer.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION, id: SessionId(threadId), createdAt: 1000, cwd: workspace, isSeeded: false,
  });
  try {
    await handle.append(events.slice(0, 3));
    await handle.flush();
    const first = await readDshTrajectory(threadId, { afterSeq: -1, limit: 2 });
    assert.deepEqual(first.events.map(event => event.seq), [0, 1]);
    assert.equal(first.hasMoreBefore, false);
    assert.equal(first.hasMoreAfter, true);
    assert.equal((first.events[1] as { surfaceOp?: string }).surfaceOp, "append");
    await handle.append(events.slice(3));
    await handle.flush();
    const tail = await readDshTrajectory(threadId, { limit: 2 });
    assert.deepEqual(tail.events.map(event => event.seq), [4, 5]);
    assert.equal(tail.hasMoreBefore, true);
    const older = await readDshTrajectory(threadId, { beforeSeq: 4, limit: 2 });
    assert.deepEqual(older.events.map(event => event.seq), [2, 3]);
    assert.equal(older.hasMoreBefore, true);
    assert.equal(older.hasMoreAfter, true);
    assert.deepEqual(older.events[1]?.data, events[3]?.data);
    const unchanged = await readDshTrajectory(threadId, { afterSeq: 5, knownRevision: tail.revision });
    assert.equal(unchanged.unchanged, true);
    assert.deepEqual(unchanged.events, []);
  } finally {
    await handle.close();
  }
  assert.deepEqual((await readDshTrajectory(threadId)).events.map(event => event.seq), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual((await readDshTrajectory("empty-thread")).events, []);
  await assert.rejects(() => readDshTrajectory("../outside"), /会话标识/);
  await assert.rejects(() => readDshTrajectory(threadId, { limit: 0 }), /页大小/);
  await assert.rejects(() => readDshTrajectory(threadId, { beforeSeq: 1, afterSeq: 0 }), /同时/);
});

test("vendored projection retains request timing and tool details across append and prepend", () => {
  const raw: TrajectoryEvent[] = [
    ...events.slice(0, 4),
    { seq: 4, time: 1210, type: "tool/call", data: { turn: 1, step: 1, callId: "call-a", name: "bash", arguments: '{"command":"pwd"}' } },
    { seq: 5, time: 1220, type: "tool/result", data: { turn: 1, step: 1, message: { id: "tool-a", role: "tool", source: { kind: "tool", callId: "call-a" }, content: [{ type: "text", text: "/workspace" }] } } },
    { ...events[4]!, seq: 6 },
    { ...events[5]!, seq: 7 },
  ];
  const projector = new TrajectoryProjector();
  const waiting = projector.update(raw.slice(0, 3), false);
  assert.equal(waiting.requests[0]?.status, "running");
  const complete = projector.update(raw, false);
  const assistant = complete.eventNodes.find(node => node.kind === "assistant");
  assert.equal(assistant?.timing?.stepStartTime, 1050);
  assert.equal(assistant?.timing?.firstTokenTime, 1100);
  const tool = complete.eventNodes.find(node => node.kind === "tool-result");
  assert.equal(tool?.name, "bash");
  assert.equal(tool?.call?.argsRaw, '{"command":"pwd"}');
  assert.deepEqual(tool?.content, [{ type: "text", text: "/workspace" }]);
  assert.equal(projector.update(raw, false).eventNodes.length, complete.eventNodes.length);
  const tail = new TrajectoryProjector();
  tail.update(raw.slice(3), true);
  assert.deepEqual(tail.update(raw, false).eventNodes, complete.eventNodes);
});
