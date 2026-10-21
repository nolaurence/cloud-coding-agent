import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@cca/protocol";
import { DshEventMapper, textOfContent, reasoningOfContent } from "./dshEvents.js";

const ROOT = "thread-1";

function mapper() {
  return new DshEventMapper({ rootSessionId: ROOT, contextWindowTokens: 100_000 });
}

function wireEvent(type: string, data: unknown, seq = 1, time = 1_700_000_000_000) {
  return { sessionId: ROOT, event: { type, seq, time, data } };
}

test("turn lifecycle maps to assistant.turn_start / turn_end", () => {
  const events = mapper().mapSessionEvent(wireEvent("turn/start", { turn: 3 }) as never);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "assistant.turn_start");
  assert.deepEqual(events[0]!.data, { turnId: "turn-3" });
  assert.equal(events[0]!.id, "thread-1-assistant.turn_start-1");

  const ended = mapper().mapSessionEvent(
    wireEvent("turn/end", { turn: 3, reason: { kind: "completed" } }) as never,
  );
  assert.equal(ended[0]!.type, "assistant.turn_end");

  const aborted = mapper().mapSessionEvent(
    wireEvent("turn/end", { turn: 3, reason: { kind: "aborted", reason: { kind: "user" } } }) as never,
  );
  assert.deepEqual(
    aborted.map((event) => event.type),
    ["assistant.turn_end", "abort"],
  );
});

test("user messages carry text and plugin sources become skill sources", () => {
  const human = mapper().mapSessionEvent(
    wireEvent("user/message", {
      id: "m1",
      role: "user",
      content: [{ type: "text", text: "你好" }],
      source: { kind: "user" },
    }) as never,
  );
  assert.equal(human[0]!.type, "user.message");
  assert.deepEqual(human[0]!.data, { content: "你好", source: undefined });

  const injected = mapper().mapSessionEvent(
    wireEvent("user/message", {
      id: "m2",
      role: "user",
      content: [{ type: "text", text: "技能上下文" }],
      source: { kind: "plugin", plugin: "code-review" },
    }) as never,
  );
  assert.deepEqual(injected[0]!.data, { content: "技能上下文", source: "skill:code-review" });
});

test("streaming chunks become message and reasoning deltas", () => {
  const events = mapper().mapSessionEvent(
    wireEvent("assistant/chunk", {
      turn: 1,
      step: 0,
      chunk: { type: "text-delta", index: 0, text: "Hel" },
    }) as never,
  );
  assert.deepEqual(events[0]!.data, { messageId: "step-1-0", deltaContent: "Hel" });

  const reasoning = mapper().mapSessionEvent(
    wireEvent("assistant/chunk", {
      turn: 1,
      step: 0,
      chunk: { type: "reasoning-delta", index: 1, text: "想" },
    }) as never,
  );
  assert.deepEqual(reasoning[0]!.data, {
    reasoningId: "step-1-0-reasoning",
    deltaContent: "想",
  });

  const ignored = mapper().mapSessionEvent(
    wireEvent("assistant/chunk", {
      turn: 1,
      step: 0,
      chunk: { type: "finish", reason: { kind: "stop" } },
    }) as never,
  );
  assert.equal(ignored.length, 0);
});

test("assistant messages map content, reasoning, and context usage", () => {
  const events = mapper().mapSessionEvent(
    wireEvent("assistant/message", {
      turn: 2,
      step: 1,
      message: {
        id: "a1",
        role: "assistant",
        content: [
          { type: "reasoning", text: "推理" },
          { type: "text", text: "答案" },
        ],
        source: { kind: "model", provider: "cca-primary", model: "m" },
      },
      usage: { inputTokens: 1200, outputTokens: 300 },
    }) as never,
  );
  assert.equal(events.length, 2);
  const message = events.find((event) => event.type === "assistant.message") as Extract<
    SessionEvent,
    { type: "assistant.message" }
  >;
  assert.deepEqual(message.data, {
    messageId: "a1",
    content: "答案",
    reasoningText: "推理",
    turnId: "turn-2",
  });
  const usage = events.find((event) => event.type === "session.usage_info");
  assert.deepEqual(usage!.data, { currentTokens: 1500, tokenLimit: 100_000 });
});

test("tool calls split MCP names and results carry success", () => {
  const events = mapper().mapSessionEvent(
    wireEvent("tool/call", {
      turn: 1,
      step: 0,
      callId: "c1",
      name: "mcp__srv__fetch",
      arguments: '{"url":"https://example.com"}',
    }) as never,
  );
  assert.deepEqual(events[0]!.data, {
    toolCallId: "c1",
    toolName: "mcp__srv__fetch",
    mcpServerName: "srv",
    mcpToolName: "fetch",
    arguments: { url: "https://example.com" },
  });

  const done = mapper().mapSessionEvent(
    wireEvent("tool/result", {
      turn: 1,
      step: 0,
      message: {
        id: "r1",
        role: "user",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            content: [{ type: "text", text: "ok" }],
            isError: false,
          },
        ],
        source: { kind: "tool", callId: "c1" },
      },
    }) as never,
  );
  assert.equal(done[0]!.type, "tool.execution_complete");
  assert.equal((done[0]!.data as { success: boolean }).success, true);

  const failed = mapper().mapSessionEvent(
    wireEvent("tool/result", {
      turn: 1,
      step: 0,
      message: {
        id: "r2",
        role: "user",
        content: [
          {
            type: "tool-result",
            toolCallId: "c2",
            content: [{ type: "text", text: "boom" }],
            isError: true,
          },
        ],
        source: { kind: "tool", callId: "c2" },
      },
      error: { name: "ToolError", code: "EFAIL" },
    }) as never,
  );
  assert.equal((failed[0]!.data as { success: boolean }).success, false);
  assert.deepEqual((failed[0]!.data as { error: { message: string } }).error, {
    message: "ToolError: EFAIL",
  });
});

test("log-only and plugin extension events are skipped", () => {
  for (const type of ["step/start", "step/end", "todo/write", "request/header", "request/context", "session/end-seed"]) {
    assert.equal(mapper().mapSessionEvent(wireEvent(type, {}) as never).length, 0, type);
  }
});

test("child session events carry the subagent id", () => {
  const events = mapper().mapSessionEvent({
    sessionId: "child-1",
    event: {
      type: "user/message",
      seq: 2,
      time: 1,
      data: {
        id: "m",
        role: "user",
        content: [{ type: "text", text: "任务" }],
        source: { kind: "user" },
      },
    },
  } as never);
  assert.equal(events[0]!.agentId, "child-1");
});

test("status, subagent, and transport events map to lifecycle signals", () => {
  const m = mapper();
  assert.equal(m.mapStatus({ sessionId: ROOT, status: "running" }).length, 0);
  const idle = m.mapStatus({ sessionId: ROOT, status: "idle" });
  assert.equal(idle[0]!.type, "session.idle");
  assert.deepEqual(idle[0]!.data, { aborted: false });

  const started = m.mapSubagentStarted({ parentSessionId: ROOT, childSessionId: "child-9" });
  assert.equal(started[0]!.type, "subagent.started");

  const ok = m.mapSubagentFinished({
    provider: "spawn-in-process",
    agentId: "child-9",
    parentSessionId: ROOT,
    childSessionId: "child-9",
    status: "ok",
    stopReason: "completed",
  });
  assert.equal(ok[0]!.type, "subagent.completed");

  const failed = m.mapSubagentFinished({
    provider: "spawn-in-process",
    agentId: "child-9",
    parentSessionId: ROOT,
    childSessionId: "child-9",
    status: "error",
    stopReason: "timeout",
  });
  assert.equal(failed[0]!.type, "subagent.failed");

  assert.deepEqual(
    m.mapTransportClosed("gone").map((event) => event.type),
    ["session.error", "abort", "session.shutdown"],
  );
  assert.deepEqual(
    m.mapAborted("stop").map((event) => event.type),
    ["abort"],
  );
});

test("content helpers extract text and reasoning blocks", () => {
  const blocks = [
    { type: "reasoning", text: "r1" },
    { type: "text", text: "t1" },
    { type: "text", text: "t2" },
    { type: "tool-call", id: "c", name: "n", arguments: "{}" },
  ];
  assert.equal(textOfContent(blocks as never), "t1t2");
  assert.equal(reasoningOfContent(blocks as never), "r1");
  assert.equal(textOfContent(undefined), "");
});
