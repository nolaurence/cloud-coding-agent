import type { ChatMessage, SubagentActivity, ToolActivity } from "@cca/protocol";

export type ChatTimelineEntry =
  | { kind: "message"; id: string; at: number; message: ChatMessage }
  | { kind: "tool"; id: string; at: number; activity: ToolActivity }
  | { kind: "subagent"; id: string; at: number; subagent: SubagentActivity };

export type ChatTimelineBlock =
  | { kind: "system"; id: string; at: number; message: ChatMessage }
  | {
      kind: "turn";
      id: string;
      at: number;
      turnId: string;
      entries: ChatTimelineEntry[];
    };

function entryTurnId(entry: ChatTimelineEntry): string {
  if (entry.kind === "message") return entry.message.turnId;
  return entry.kind === "tool" ? entry.activity.turnId : entry.subagent.turnId;
}

function compareEntries(left: ChatTimelineEntry, right: ChatTimelineEntry): number {
  if (left.at !== right.at) return left.at - right.at;
  if (left.kind !== right.kind) {
    const rank = { message: 0, subagent: 1, tool: 2 } as const;
    return rank[left.kind] - rank[right.kind];
  }
  return left.id.localeCompare(right.id);
}

export function deriveChatTimeline(
  messages: readonly ChatMessage[],
  activities: readonly ToolActivity[],
  subagents: readonly SubagentActivity[] = [],
): ChatTimelineBlock[] {
  const delegatedToolCallIds = new Set(subagents.map((subagent) => subagent.toolCallId));
  const entries: ChatTimelineEntry[] = [
    ...messages.map((message) => ({
      kind: "message" as const,
      id: `message:${message.id}`,
      at: message.createdAt,
      message,
    })),
    ...activities.filter((activity) => !delegatedToolCallIds.has(activity.id)).map((activity) => ({
      kind: "tool" as const,
      id: `tool:${activity.id}`,
      at: activity.startedAt,
      activity,
    })),
    ...subagents.filter((subagent) => !subagent.parentAgentId).map((subagent) => ({
      kind: "subagent" as const,
      id: `subagent:${subagent.id}`,
      at: subagent.startedAt,
      subagent,
    })),
  ].sort(compareEntries);

  const blocks: ChatTimelineBlock[] = [];
  const turnBlocks = new Map<string, Extract<ChatTimelineBlock, { kind: "turn" }>>();

  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "system") {
      blocks.push({
        kind: "system",
        id: entry.id,
        at: entry.at,
        message: entry.message,
      });
      continue;
    }

    const explicitTurnId = entryTurnId(entry).trim();
    const turnId = explicitTurnId || `unscoped:${entry.id}`;
    const existing = turnBlocks.get(turnId);
    if (existing) {
      existing.entries.push(entry);
      existing.at = Math.min(existing.at, entry.at);
      continue;
    }

    const block: Extract<ChatTimelineBlock, { kind: "turn" }> = {
      kind: "turn",
      id: `turn:${turnId}`,
      at: entry.at,
      turnId,
      entries: [entry],
    };
    turnBlocks.set(turnId, block);
    blocks.push(block);
  }

  for (const block of turnBlocks.values()) {
    block.entries.sort(compareEntries);
  }
  blocks.sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
  return blocks;
}

export function findTerminalAssistantEntry(
  entries: readonly ChatTimelineEntry[],
): Extract<ChatTimelineEntry, { kind: "message" }> | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.kind === "message" && entry.message.role === "assistant") return entry;
  }
  return null;
}

export function turnStartedAt(entries: readonly ChatTimelineEntry[]): number | null {
  const userEntry = entries.find(
    (entry) => entry.kind === "message" && entry.message.role === "user",
  );
  return userEntry?.at ?? entries[0]?.at ?? null;
}

export function turnEndedAt(entries: readonly ChatTimelineEntry[]): number | null {
  let endedAt: number | null = null;
  for (const entry of entries) {
    const candidate = entry.kind === "tool"
      ? (entry.activity.endedAt ?? entry.activity.startedAt)
      : entry.kind === "subagent"
        ? (entry.subagent.endedAt ?? entry.subagent.startedAt)
        : entry.at;
    endedAt = endedAt === null ? candidate : Math.max(endedAt, candidate);
  }
  return endedAt;
}
