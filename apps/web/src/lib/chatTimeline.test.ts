import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, SubagentActivity, ToolActivity } from "@cca/protocol";
import {
  deriveChatTimeline,
  deriveTurnContent,
  findTerminalAssistantEntry,
  turnEndedAt,
  turnStartedAt,
} from "./chatTimeline.js";

function message(
  id: string,
  role: ChatMessage["role"],
  turnId: string,
  createdAt: number,
): ChatMessage {
  return { id, role, turnId, createdAt, text: id };
}

function activity(
  id: string,
  turnId: string,
  startedAt: number,
  endedAt?: number,
): ToolActivity {
  return {
    id,
    turnId,
    startedAt,
    endedAt,
    toolName: "read_file",
    status: endedAt ? "complete" : "running",
  };
}

function subagent(
  id: string,
  turnId: string,
  toolCallId: string,
  startedAt: number,
  endedAt?: number,
  parentAgentId?: string,
): SubagentActivity {
  return {
    id,
    turnId,
    parentAgentId,
    toolCallId,
    agentName: "explore",
    agentDisplayName: "Explore",
    agentDescription: "探索代码",
    status: endedAt ? "complete" : "running",
    messages: [],
    activities: [],
    startedAt,
    endedAt,
  };
}

test("deriveChatTimeline groups interleaved messages and tools by turn", () => {
  const blocks = deriveChatTimeline(
    [
      message("user-1", "user", "turn-1", 100),
      message("assistant-comment", "assistant", "turn-1", 120),
      message("assistant-final", "assistant", "turn-1", 180),
      message("system", "system", "", 90),
      message("user-2", "user", "turn-2", 200),
    ],
    [activity("tool-1", "turn-1", 130, 160), activity("tool-2", "turn-2", 210)],
  );

  assert.deepEqual(
    blocks.map((block) => [block.kind, block.id]),
    [
      ["system", "message:system"],
      ["turn", "turn:turn-1"],
      ["turn", "turn:turn-2"],
    ],
  );

  const firstTurn = blocks[1];
  assert.equal(firstTurn?.kind, "turn");
  if (firstTurn?.kind !== "turn") return;
  assert.deepEqual(
    firstTurn.entries.map((entry) => entry.id),
    ["message:user-1", "message:assistant-comment", "tool:tool-1", "message:assistant-final"],
  );
  assert.equal(findTerminalAssistantEntry(firstTurn.entries)?.message.id, "assistant-final");
});

test("turn boundaries use the user prompt and completed tool timestamp", () => {
  const blocks = deriveChatTimeline(
    [message("user", "user", "turn", 1_000), message("assistant", "assistant", "turn", 2_000)],
    [activity("tool", "turn", 1_500, 2_500)],
  );
  const turn = blocks[0];
  assert.equal(turn?.kind, "turn");
  if (turn?.kind !== "turn") return;

  assert.equal(turnStartedAt(turn.entries), 1_000);
  assert.equal(turnEndedAt(turn.entries), 2_500);
});

test("replaces delegated task tools with one top-level subagent entry", () => {
  const root = subagent("agent-1", "turn", "task-tool", 1_400, 2_600);
  const nested = subagent("agent-2", "turn", "nested-task", 1_700, 2_100, "agent-1");
  const blocks = deriveChatTimeline(
    [message("user", "user", "turn", 1_000)],
    [activity("task-tool", "turn", 1_300, 2_650), activity("root-read", "turn", 1_500, 1_600)],
    [root, nested],
  );
  const turn = blocks[0];
  assert.equal(turn?.kind, "turn");
  if (turn?.kind !== "turn") return;

  assert.deepEqual(
    turn.entries.map((entry) => entry.id),
    ["message:user", "subagent:agent-1", "tool:root-read"],
  );
  assert.equal(turnEndedAt(turn.entries), 2_600);
});

test("process groups stop at every reply and keep reasoning before its own response", () => {
  const blocks = deriveChatTimeline([
    message("user", "user", "turn", 100),
    { ...message("comment", "assistant", "turn", 120), reasoning: "先检查" },
    { ...message("final", "assistant", "turn", 180), reasoning: "检查完成" },
  ], [activity("read", "turn", 110, 115), activity("edit", "turn", 140, 160)]);
  const turn = blocks[0];
  assert.equal(turn?.kind, "turn");
  if (turn?.kind !== "turn") return;
  const content = deriveTurnContent(turn.entries);
  assert.deepEqual(content.map((block) => [block.kind, block.id]), [
    ["message", "message:user"], ["process", "process:tool:read"],
    ["message", "message:comment"], ["process", "process:tool:edit"],
    ["message", "message:final"],
  ]);
  const groups = content.filter((block) => block.kind === "process");
  assert.ok(groups.every((group) => group.closed));
  assert.deepEqual(groups.map((group) => group.entries.map((entry) => entry.id)), [
    ["tool:read", "message:comment"], ["tool:edit", "message:final"],
  ]);
  const reasoning = groups[1]?.entries[1];
  assert.equal(reasoning?.kind, "message");
  if (reasoning?.kind === "message") {
    assert.equal(reasoning.message.text, "");
    assert.equal(reasoning.message.reasoning, "检查完成");
  }
});

test("live groups retain identity when extended and close on reply or turn completion", () => {
  const tool = { kind: "tool" as const, id: "tool:read", at: 100, activity: activity("read", "turn", 100) };
  const thought = { kind: "message" as const, id: "message:thought", at: 120,
    message: { ...message("thought", "assistant", "turn", 120), text: "", reasoning: "正在检查" } };
  const initial = deriveTurnContent([tool], true)[0];
  const live = deriveTurnContent([tool, thought], true)[0];
  assert.equal(live?.id, initial?.id);
  assert.equal(live?.kind, "process");
  if (live?.kind === "process") assert.equal(live.closed, false);
  const completed = deriveTurnContent([tool, thought])[0];
  if (completed?.kind === "process") assert.equal(completed.closed, true);
  const reply = deriveTurnContent([tool, { ...thought, message: { ...thought.message, text: "检查好了" } }], true);
  assert.equal(reply.length, 2);
  if (reply[0]?.kind === "process") assert.equal(reply[0].closed, true);
});

test("attachment replies and interleaved user input stay outside process groups", () => {
  const blocks = deriveChatTimeline([
    message("user", "user", "turn", 100),
    { ...message("image", "assistant", "turn", 130), text: "", attachments: [
      { kind: "image", id: "image", displayName: "截图.png", ownerId: "assistant" },
    ] },
    message("steering", "user", "turn", 150),
  ], [activity("read", "turn", 110, 120), activity("edit", "turn", 140, 145)]);
  const turn = blocks[0];
  if (turn?.kind !== "turn") return;
  assert.deepEqual(deriveTurnContent(turn.entries, true).map((block) => block.kind), [
    "message", "process", "message", "process", "message",
  ]);
});
