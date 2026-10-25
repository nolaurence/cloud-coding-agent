import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeStats } from "@cca/protocol";
import {
  applyDshStatsEvent,
  dshRuntimeStats,
  emptyDshStats,
  firstTokenTime,
  normalizeDshStats,
} from "./dshStats.js";

function event(type: string, time: number, data: unknown) {
  return { type, time, seq: 1, data } as never;
}

test("folds turns, steps, usage, cache tokens and decode timing like sessionStats", () => {
  let state = emptyDshStats();
  state = applyDshStatsEvent(state, event("step/start", 1_000, { turn: 1, step: 1 }));
  state = applyDshStatsEvent(
    state,
    event("assistant/message", 2_500, {
      turn: 1,
      step: 1,
      message: { id: "a", role: "assistant", content: [{ type: "text", text: "hi" }], source: { kind: "model" } },
      usage: { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 10, outputTokens: 50 },
      stream: [
        { type: "text-chunks", time0: 2_000, index: 0, dt: [100, 100], texts: ["", "hi"] },
      ],
    }),
  );
  assert.equal(state.llmMs, 1_500);
  assert.equal(state.ttftMs, 1_100);
  assert.equal(state.ttftSteps, 1);
  assert.equal(state.decodeMs, 400);
  assert.equal(state.decodeTokens, 50);
  assert.equal(state.inputTokens, 100);
  assert.equal(state.cacheReadTokens, 900);
  assert.equal(state.cacheWriteTokens, 10);
  assert.equal(state.outputTokens, 50);
  assert.equal(state.turns, 0);
  assert.equal(state.steps, 0);

  state = applyDshStatsEvent(state, event("step/end", 2_600, { turn: 1, step: 1 }));
  assert.equal(state.turns, 1);
  assert.equal(state.steps, 1);

  state = applyDshStatsEvent(state, event("step/start", 3_000, { turn: 1, step: 2 }));
  state = applyDshStatsEvent(state, event("step/end", 3_500, { turn: 1, step: 2 }));
  assert.equal(state.turns, 1);
  assert.equal(state.steps, 2);

  state = applyDshStatsEvent(state, event("step/start", 4_000, { turn: 2, step: 1 }));
  state = applyDshStatsEvent(state, event("step/end", 4_500, { turn: 2, step: 1 }));
  assert.equal(state.turns, 2);
  assert.equal(state.steps, 3);

  const stats = dshRuntimeStats(state);
  assert.equal(stats.runtime, "dsh");
  assert.equal(stats.turns, 2);
  assert.equal(stats.steps, 3);
  assert.equal(stats.lastTurn, 2);
  assert.equal(stats.updatedAt, 4_500);
});

test("tool time pairs call and result by callId", () => {
  let state = emptyDshStats();
  state = applyDshStatsEvent(state, event("tool/call", 1_000, { callId: "c1", name: "read", arguments: "{}" }));
  state = applyDshStatsEvent(
    state,
    event("tool/result", 2_500, {
      message: {
        id: "r",
        role: "tool",
        toolCallId: "c1",
        source: { kind: "tool", callId: "c1" },
        content: [{ type: "text", text: "ok" }],
      },
    }),
  );
  assert.equal(state.toolMs, 1_500);
  assert.deepEqual(state.pendingCalls, {});

  // A second result for the same call is ignored.
  state = applyDshStatsEvent(
    state,
    event("tool/result", 9_000, {
      message: { id: "r2", role: "tool", toolCallId: "c1", source: { kind: "tool", callId: "c1" }, content: [] },
    }),
  );
  assert.equal(state.toolMs, 1_500);

  state = applyDshStatsEvent(state, event("tool/call", 3_000, { callId: "c2", name: "bash", arguments: "{}" }));
  state = applyDshStatsEvent(state, event("turn/end", 4_000, { turn: 1, reason: { kind: "completed" } }));
  assert.deepEqual(state.pendingCalls, {});
});

test("assistant/attempt first token survives to the assembled message", () => {
  let state = emptyDshStats();
  state = applyDshStatsEvent(state, event("step/start", 1_000, { turn: 1, step: 1 }));
  state = applyDshStatsEvent(
    state,
    event("assistant/attempt", 1_800, {
      turn: 1,
      step: 1,
      stream: [
        { type: "chunk", time: 1_700, chunk: { type: "block-start", index: 0, blockType: "text" } },
        { type: "chunk", time: 1_800, chunk: { type: "text-delta", index: 0, text: "x" } },
      ],
    }),
  );
  state = applyDshStatsEvent(
    state,
    event("assistant/message", 2_800, {
      turn: 1,
      step: 1,
      message: { id: "a", role: "assistant", content: [], source: { kind: "model" } },
      usage: { inputTokens: 10, outputTokens: 20 },
      stream: [{ type: "text-chunks", time0: 2_000, index: 0, dt: [100], texts: ["late"] }],
    }),
  );
  assert.equal(state.ttftMs, 800);
  assert.equal(state.decodeMs, 1_000);
  assert.equal(state.decodeTokens, 20);
});

test("firstTokenTime supports packed runs and raw deltas", () => {
  assert.equal(
    firstTokenTime([
      { type: "chunk", time: 100, chunk: { type: "block-start", index: 0, blockType: "text" } },
      { type: "chunk", time: 150, chunk: { type: "text-delta", index: 0, text: "" } },
      { type: "chunk", time: 200, chunk: { type: "reasoning-delta", index: 1, text: "r" } },
    ]),
    200,
  );
  assert.equal(
    firstTokenTime([
      { type: "text-chunks", time0: 500, index: 0, dt: [10, 20], texts: ["", "", "x"] },
    ]),
    530,
  );
  assert.equal(
    firstTokenTime([
      { type: "tool-call-chunks", time0: 700, index: 0, dt: [0], id: "c", name: "read", args: [""] },
    ]),
    700,
  );
  assert.equal(firstTokenTime(undefined), undefined);
});

test("normalizes persisted stats and rejects other runtimes", () => {
  const persisted: RuntimeStats = {
    runtime: "dsh",
    turns: 2.9,
    steps: 3,
    inputTokens: 10,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    outputTokens: 30,
    llmMs: 1_000,
    toolMs: 500,
    ttftMs: 300,
    ttftSteps: 1,
    decodeMs: 200,
    decodeTokens: 30,
    lastTurn: 2,
    updatedAt: 123,
  };
  const state = normalizeDshStats(persisted);
  assert.equal(state.turns, 2);
  assert.equal(state.steps, 3);
  assert.equal(state.lastTurn, 2);
  assert.equal(state.openStep, null);
  assert.deepEqual(state.pendingCalls, {});
  assert.equal(normalizeDshStats({ ...persisted, runtime: "codex" }).steps, 0);
  assert.equal(normalizeDshStats(undefined).steps, 0);
});
