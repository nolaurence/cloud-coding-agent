import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@github/copilot-sdk";
import { CodexSession } from "./codex.js";

test("Codex native plan notifications become persisted tool events with structured arguments", () => {
  const events: SessionEvent[] = [];
  const session = Object.create(CodexSession.prototype) as {
    threadId: string;
    notification(method: string, params: Record<string, unknown>): void;
    emit(event: unknown): void;
  };
  session.threadId = "thread-1";
  session.emit = (event) => events.push(event as SessionEvent);
  const plan = [{ step: "检查实现", status: "completed" }, { step: "验证行为", status: "in_progress" }];
  session.notification("turn/plan/updated", { threadId: "thread-1", turnId: "turn-1", plan, explanation: "先验证再交付" });
  assert.equal(events.length, 2);
  assert.equal(events[0]?.type, "tool.execution_start");
  assert.equal(events[1]?.type, "tool.execution_complete");
  const start = events[0] as Extract<SessionEvent, { type: "tool.execution_start" }>;
  const end = events[1] as Extract<SessionEvent, { type: "tool.execution_complete" }>;
  assert.equal(start.data.toolName, "update_plan");
  assert.deepEqual(start.data.arguments, { plan, explanation: "先验证再交付" });
  assert.equal(start.data.toolCallId, end.data.toolCallId);
  session.notification("turn/plan/updated", { threadId: "other", plan });
  assert.equal(events.length, 2);
});
