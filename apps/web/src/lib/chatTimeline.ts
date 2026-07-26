import type { ChatMessage, ToolActivity } from "@cca/protocol";

export type ChatTimelineEntry =
  | { kind: "message"; id: string; at: number; message: ChatMessage }
  | { kind: "tool"; id: string; at: number; activity: ToolActivity };

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
  return entry.kind === "message" ? entry.message.turnId : entry.activity.turnId;
}

function compareEntries(left: ChatTimelineEntry, right: ChatTimelineEntry): number {
  if (left.at !== right.at) return left.at - right.at;
  if (left.kind !== right.kind) return left.kind === "message" ? -1 : 1;
  return left.id.localeCompare(right.id);
}

export function deriveChatTimeline(
  messages: readonly ChatMessage[],
  activities: readonly ToolActivity[],
): ChatTimelineBlock[] {
  const entries: ChatTimelineEntry[] = [
    ...messages.map((message) => ({
      kind: "message" as const,
      id: `message:${message.id}`,
      at: message.createdAt,
      message,
    })),
    ...activities.map((activity) => ({
      kind: "tool" as const,
      id: `tool:${activity.id}`,
      at: activity.startedAt,
      activity,
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
    const candidate =
      entry.kind === "tool" ? (entry.activity.endedAt ?? entry.activity.startedAt) : entry.at;
    endedAt = endedAt === null ? candidate : Math.max(endedAt, candidate);
  }
  return endedAt;
}
