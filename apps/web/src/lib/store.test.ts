import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadEvent } from "@cca/protocol";
import { applyThreadEvent } from "./store.js";

type ThreadState = ReturnType<typeof applyThreadEvent>;
type Snapshot = Extract<ThreadEvent, { kind: "snapshot" }>;

function emptyState(): ThreadState {
  return {
    messages: [],
    activities: [],
    subagents: [],
    contextUsage: null,
    runtimeStats: null,
    running: false,
    loaded: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    live: { text: "", reasoning: "", turnId: null },
    pendingPermission: null,
    error: null,
  };
}

function runningState(): ThreadState {
  return {
    ...emptyState(),
    running: true,
    activeTurnId: "turn-1",
    activeTurnStartedAt: 1_000,
  };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    kind: "snapshot",
    messages: [],
    activities: [],
    running: true,
    ...overrides,
  };
}

test("running snapshots use the request start rather than the current Codex message", () => {
  const next = applyThreadEvent(runningState(), snapshot({
    activeTurn: { turnId: "turn-1", startedAt: 1_000 },
    live: { text: "继续处理", reasoning: "", turnId: "turn-1", startedAt: 8_000 },
  }));

  assert.equal(next.activeTurnId, "turn-1");
  assert.equal(next.activeTurnStartedAt, 1_000);
  assert.equal(next.live.text, "继续处理");
});

test("reloading before the first response restores the server request start", () => {
  const next = applyThreadEvent(emptyState(), snapshot({
    activeTurn: { turnId: "turn-1", startedAt: 1_000 },
  }));

  assert.equal(next.running, true);
  assert.equal(next.activeTurnId, "turn-1");
  assert.equal(next.activeTurnStartedAt, 1_000);
});

test("older server snapshots preserve the timer when the same request reconnects", () => {
  const next = applyThreadEvent(runningState(), snapshot({
    live: { text: "第二段回复", reasoning: "", turnId: "turn-1", startedAt: 8_000 },
  }));

  assert.equal(next.activeTurnStartedAt, 1_000);
});

test("older server snapshots infer the request start from its user message on reload", () => {
  const next = applyThreadEvent(emptyState(), snapshot({
    messages: [
      { id: "user-1", role: "user", text: "继续", turnId: "turn-1", createdAt: 1_000 },
      { id: "assistant-1", role: "assistant", text: "开始处理", turnId: "turn-1", createdAt: 4_000 },
    ],
    live: { text: "继续处理", reasoning: "", turnId: "turn-1", startedAt: 8_000 },
  }));

  assert.equal(next.activeTurnStartedAt, 1_000);
});

test("a delayed Codex user message does not reset the active request timer", () => {
  const next = applyThreadEvent(runningState(), {
    kind: "user.message",
    message: { id: "user-1", role: "user", text: "继续", turnId: "turn-1", createdAt: 8_000 },
  });

  assert.equal(next.activeTurnStartedAt, 1_000);
  assert.equal(next.messages[0]?.createdAt, 8_000);
});

test("the timer survives snapshots between Codex messages while tools run", () => {
  const next = applyThreadEvent(runningState(), snapshot({
    activeTurn: { turnId: "turn-1", startedAt: 1_000 },
    messages: [
      { id: "user-1", role: "user", text: "继续", turnId: "turn-1", createdAt: 3_000 },
      { id: "assistant-1", role: "assistant", text: "执行工具", turnId: "turn-1", createdAt: 4_000 },
    ],
  }));

  assert.equal(next.activeTurnStartedAt, 1_000);
  assert.equal(next.live.text, "");
});

test("a new request uses the server timestamp and resets only after the previous request ends", () => {
  const ended = applyThreadEvent(runningState(), { kind: "turn.end", turnId: "turn-1" });
  assert.equal(ended.activeTurnStartedAt, null);

  const next = applyThreadEvent(ended, { kind: "turn.start", turnId: "turn-2", startedAt: 20_000 });
  assert.equal(next.activeTurnId, "turn-2");
  assert.equal(next.activeTurnStartedAt, 20_000);
});

test("snapshots of another request replace rather than inherit the previous timer", () => {
  const next = applyThreadEvent(runningState(), snapshot({
    activeTurn: { turnId: "turn-2", startedAt: 20_000 },
    live: { text: "新的任务", reasoning: "", turnId: "turn-2", startedAt: 25_000 },
  }));

  assert.equal(next.activeTurnId, "turn-2");
  assert.equal(next.activeTurnStartedAt, 20_000);
});

test("idle snapshots clear request timing even if stale turn metadata is present", () => {
  const next = applyThreadEvent(runningState(), snapshot({
    running: false,
    activeTurn: { turnId: "turn-1", startedAt: 1_000 },
  }));

  assert.equal(next.running, false);
  assert.equal(next.activeTurnId, null);
  assert.equal(next.activeTurnStartedAt, null);
});
