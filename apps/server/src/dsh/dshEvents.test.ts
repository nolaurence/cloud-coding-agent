import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@github/copilot-sdk";
import { DshEventMapper, textOfContent, reasoningOfContent } from "./dshEvents.js";

const ROOT = "thread-1";

function mapper() {
  return new DshEventMapper({ rootSessionId: ROOT, contextWindowTokens: 100_000 });
}

function wireEvent(type: string, data: unknown, seq = 1, time = 1_700_000_000_000) {
  return { sessionId: ROOT, event: { type, seq, time, data } };
}

function messageData(events: SessionEvent[]) {
  return events.find((event) => event.type === "assistant.message") as
    | Extract<SessionEvent, { type: "assistant.message" }>
    | undefined;
}

test("turn lifecycle maps to assistant.turn_start / turn_end / abort / error", () => {
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
  assert.deepEqual(aborted.map((event) => event.type), ["assistant.turn_end", "abort"]);

  const failed = mapper().mapSessionEvent(
    wireEvent("turn/end", {
      turn: 3,
      reason: { kind: "error", error: { message: "boom" } },
    }) as never,
  );
  assert.deepEqual(failed.map((event) => event.type), ["assistant.turn_end", "session.error"]);
});

test("only human user messages are surfaced; injected context is internal", () => {
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

  for (const kind of ["agent-instructions", "runtime-context", "plugin"]) {
    const injected = mapper().mapSessionEvent(
      wireEvent("user/message", {
        id: "m2",
        role: "user",
        content: [{ type: "text", text: "注入上下文" }],
        source: { kind },
      }) as never,
    );
    assert.equal(injected.length, 0, kind);
  }

  const nested = mapper().mapSessionEvent(
    wireEvent("user/message", {
      message: {
        id: "m3",
        role: "user",
        content: [{ type: "text", text: "旧格式" }],
        source: { kind: "user" },
      },
    }) as never,
  );
  assert.equal(nested[0]!.type, "user.message");
});

test("assistant message carries text, reasoning, usage and stable ids", () => {
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
        source: { kind: "model" },
      },
      usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
    }, 11) as never,
  );
  assert.equal(events.length, 2);
  const message = messageData(events);
  assert.deepEqual(message?.data, {
    messageId: "step-2-1",
    content: "答案",
    reasoningText: "推理",
    turnId: "turn-2",
  });
  assert.equal(message?.id, "thread-1-assistant.message-11");
  const usage = events.find((event) => event.type === "session.usage_info");
  assert.deepEqual(usage?.data, { currentTokens: 1500, tokenLimit: 100_000 });
});

test("assistant chunks become deltas with the final message id", () => {
  const text = mapper().mapSessionEvent(
    wireEvent("assistant/chunk", {
      turn: 1,
      step: 2,
      chunk: { type: "text-delta", index: 0, text: "Hel" },
    }) as never,
  );
  assert.deepEqual(text[0]!.data, { messageId: "step-1-2", deltaContent: "Hel" });

  const reasoning = mapper().mapSessionEvent(
    wireEvent("assistant/chunk", {
      turn: 1,
      step: 2,
      chunk: { type: "reasoning-delta", index: 1, text: "想" },
    }) as never,
  );
  assert.deepEqual(reasoning[0]!.data, {
    reasoningId: "step-1-2-reasoning",
    deltaContent: "想",
  });

  const ignored = mapper().mapSessionEvent(
    wireEvent("assistant/chunk", {
      turn: 1,
      step: 2,
      chunk: { type: "finish", reason: { kind: "stop" } },
    }) as never,
  );
  assert.equal(ignored.length, 0);
});

test("tool call and tool result map to the application activity contract", () => {
  const started = mapper().mapSessionEvent(
    wireEvent("tool/call", {
      turn: 1,
      step: 1,
      callId: "c1",
      name: "mcp__srv__fetch",
      arguments: '{"url":"https://example.com"}',
    }) as never,
  );
  assert.deepEqual(started[0]!.data, {
    toolCallId: "c1",
    toolName: "mcp__srv__fetch",
    mcpServerName: "srv",
    mcpToolName: "fetch",
    arguments: { url: "https://example.com" },
  });

  const done = mapper().mapSessionEvent(
    wireEvent("tool/result", {
      turn: 1,
      step: 1,
      message: {
        id: "r1",
        role: "tool",
        toolCallId: "c1",
        isError: false,
        source: { kind: "tool", callId: "c1" },
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            content: [{ type: "text", text: "ok" }],
            isError: false,
          },
        ],
      },
    }) as never,
  );
  assert.equal(done[0]!.type, "tool.execution_complete");
  assert.deepEqual(done[0]!.data, {
    toolCallId: "c1",
    success: true,
    result: { content: "ok", detailedContent: "ok" },
  });

  const failed = mapper().mapSessionEvent(
    wireEvent("tool/result", {
      turn: 1,
      step: 1,
      message: {
        id: "r2",
        role: "tool",
        toolCallId: "c2",
        isError: true,
        source: { kind: "tool", callId: "c2" },
        content: [
          {
            type: "tool-result",
            toolCallId: "c2",
            content: [{ type: "text", text: "boom" }],
            isError: true,
          },
        ],
      },
      error: { name: "ToolError", code: "EFAIL" },
    }) as never,
  );
  assert.equal((failed[0]!.data as { success: boolean }).success, false);
  assert.deepEqual((failed[0]!.data as { error: { message: string } }).error, {
    message: "ToolError: EFAIL",
  });

  const directText = mapper().mapSessionEvent(
    wireEvent("tool/result", {
      turn: 1,
      step: 1,
      message: {
        id: "r3",
        role: "tool",
        toolCallId: "c3",
        isError: false,
        source: { kind: "tool", callId: "c3" },
        content: [{ type: "text", text: "file content" }],
      },
    }) as never,
  );
  assert.deepEqual(directText[0]!.data, {
    toolCallId: "c3",
    success: true,
    result: { content: "file content", detailedContent: "file content" },
  });
});

test("log-only events are skipped", () => {
  for (const type of [
    "agent/inbox/spliced",
    "step/start",
    "step/end",
    "system/message",
    "session/title",
    "todo/write",
    "request/header",
    "request/context",
    "session/end-seed",
  ]) {
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

test("status, subagent, and transport notifications map to lifecycle signals", () => {
  const m = mapper();
  assert.equal(m.mapStatus({ sessionId: ROOT, status: "running" }).length, 0);
  assert.equal(m.mapStatus({ sessionId: "child-9", status: "idle" }).length, 0);
  const idle = m.mapStatus({ sessionId: ROOT, status: "idle" });
  assert.equal(idle[0]!.type, "session.idle");
  assert.deepEqual(idle[0]!.data, { aborted: false });

  const started = m.mapSubagentStarted({ parentSessionId: ROOT, childSessionId: "child-9" });
  assert.equal(started[0]!.type, "subagent.started");
  assert.equal(started[0]!.agentId, "child-9");

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
  assert.deepEqual(m.mapAborted("stop").map((event) => event.type), ["abort"]);
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
