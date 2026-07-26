import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, ToolActivity } from "@cca/protocol";
import {
  deriveChatTimeline,
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
