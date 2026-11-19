import fs from "node:fs";
import path from "node:path";
import type { SessionEvent } from "@github/copilot-sdk";
import type { DshTrajectoryEvent, DshTrajectoryPage, DshTrajectoryQuery } from "@cca/protocol";
import { flushDbWrites, query, usingDatabase } from "./db.js";
import { CODEX_HOME } from "./codex.js";
import {
  assertTrajectoryThreadId, resolveTrajectoryQuery, trajectoryPage, unchangedTrajectoryPage,
} from "./trajectoryPaging.js";

/** Codex 会话原始事件日志,与 {@link CodexSession.emit} 的写入位置一致。 */
function journalPath(threadId: string): string {
  return path.join(CODEX_HOME, threadId, "cca-events.jsonl");
}

/** 容错解析追加式 JSONL:写入被中断时末行可能只剩半条记录,跳过而不是让整个会话不可读。 */
function readJournal(threadId: string): SessionEvent[] {
  const file = journalPath(threadId);
  if (!fs.existsSync(file)) return [];
  const events: SessionEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as SessionEvent;
      if (typeof parsed.id === "string" && typeof parsed.type === "string"
        && typeof parsed.timestamp === "string" && parsed.data !== null && typeof parsed.data === "object") {
        events.push(parsed);
      }
    } catch {
      console.error("[cca] skipped a corrupted codex trajectory journal line", file);
    }
  }
  return events;
}

/** 数据库中的持久历史是权威来源(与 CodexSession.open 的对账口径一致)。 */
async function readStoredEvents(threadId: string): Promise<SessionEvent[]> {
  if (!usingDatabase()) return [];
  await flushDbWrites();
  const { rows } = await query<{ data: string | SessionEvent }>(
    "SELECT data FROM thread_events WHERE thread_id = ? ORDER BY sequence_number", [threadId]);
  return rows.map(({ data }) => typeof data === "string" ? JSON.parse(data) as SessionEvent : data);
}

async function loadRawEvents(threadId: string): Promise<SessionEvent[]> {
  const stored = await readStoredEvents(threadId);
  const journal = readJournal(threadId);
  if (!journal.length) return stored;
  if (!stored.length) return journal;
  const known = new Set(stored.map(event => event.id));
  return [...stored, ...journal.filter(event => !known.has(event.id))];
}

/** 廉价 revision:数据库计数加日志文件形态,未变更时不必解码整本日志。 */
async function trajectoryRevision(threadId: string): Promise<string> {
  const parts: string[] = [];
  if (usingDatabase()) {
    await flushDbWrites();
    const { rows } = await query<{ total: unknown; last: unknown }>(
      "SELECT COUNT(*) AS total, COALESCE(MAX(sequence_number), -1) AS last FROM thread_events WHERE thread_id = ?",
      [threadId]);
    parts.push(`db:${String(rows[0]?.total ?? 0)}:${String(rows[0]?.last ?? -1)}`);
  }
  try {
    const stat = fs.statSync(journalPath(threadId));
    parts.push(`journal:${stat.size}:${stat.mtimeMs}`);
  } catch {
    parts.push("journal:none");
  }
  return parts.join("|");
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** tool/call 的 arguments 必须是模型产出的原始 JSON 字符串。 */
function argumentsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "{}";
  try { return JSON.stringify(value) ?? "{}"; } catch { return "{}"; }
}

function resultText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value) ?? ""; } catch { return ""; }
}

type Draft = Omit<DshTrajectoryEvent, "seq">;

/**
 * 将 Codex 原始事件投影为 DSH 形状的轨迹事件,复用 vendored 轨迹投影器。
 *
 * 回合边界:`user.message` 打开回合(先补关上一轮未收到 idle 的残留),
 * `session.idle` 关闭。step 边界由每次 `assistant.message`(一次模型调用)划定,
 * `step/start` 取上一条事件的时间,使模型调用在时间线上有可见时长;工具调用
 * 预占下一个 step 号,由紧随的 `assistant.message` 补上 `step/start`——
 * Codex 的 reasoning 以 "reasoning" 伪工具的开始/完成对出现且早于消息,
 * 若提前开 step 会产生没有消息的幽灵请求行。`assistant.message_delta`
 * 不持久化,流式增量无法回放,只有最终消息进入轨迹。
 */
export function projectCodexTrajectoryEvents(raw: readonly SessionEvent[]): DshTrajectoryEvent[] {
  const drafts: Draft[] = [];
  let turn = 0;
  let step = 0;
  let turnOpen = false;
  let stepOpen = false;
  let lastTime = 0;
  const push = (type: string, data: unknown, time: number) => { drafts.push({ time, type, data }); };
  const openTurn = (time: number) => {
    if (turnOpen) return;
    turn += 1;
    step = 0;
    stepOpen = false;
    push("turn/start", { turn }, time);
    turnOpen = true;
  };
  const closeTurn = (time: number, reason: unknown) => {
    if (stepOpen) {
      push("step/end", { turn, step }, time);
      stepOpen = false;
    }
    if (!turnOpen) return;
    push("turn/end", { turn, reason }, time);
    turnOpen = false;
  };
  /** 尚未开 step 时,工具调用预占下一个 step 号;`step/start` 由紧随的 assistant.message 补齐。 */
  const pendingStep = (): number => (stepOpen ? step : step + 1);
  const beginStep = (time: number) => {
    if (stepOpen) {
      push("step/end", { turn, step }, time);
      stepOpen = false;
    }
    step += 1;
    push("step/start", { turn, step }, time);
    stepOpen = true;
  };

  for (const event of raw) {
    const time = Date.parse(event.timestamp);
    if (!Number.isFinite(time)) continue;
    switch (event.type) {
      case "user.message": {
        // 进程中断后恢复的会话,上一轮可能没有 idle;按 DSH 的孤儿回合语义补一个 interrupted 收尾
        closeTurn(time, { kind: "interrupted" });
        openTurn(time);
        push("user/message", {
          id: event.id,
          role: "user",
          content: [{ type: "text", text: textOf(event.data.content) }],
          source: { kind: "user" },
        }, time);
        break;
      }
      case "assistant.turn_start":
        openTurn(time);
        break;
      case "assistant.message": {
        openTurn(time);
        beginStep(lastTime);
        const content = textOf(event.data.content);
        push("assistant/message", {
          turn,
          step,
          message: {
            id: event.data.messageId,
            role: "assistant",
            content: content ? [{ type: "text", text: content }] : [],
            source: { kind: "model", provider: "codex", model: textOf(event.data.model) },
          },
          stream: [],
        }, time);
        break;
      }
      case "tool.execution_start": {
        openTurn(time);
        push("tool/call", {
          turn,
          step: pendingStep(),
          callId: event.data.toolCallId,
          name: event.data.toolName,
          arguments: argumentsText(event.data.arguments),
        }, time);
        break;
      }
      case "tool.execution_complete": {
        openTurn(time);
        const success = event.data.success !== false;
        const failure = event.data.error;
        const content = resultText(event.data.result?.content);
        push("tool/result", {
          turn,
          step: pendingStep(),
          message: {
            id: event.id,
            role: "tool",
            content: content ? [{ type: "text", text: content }] : [],
            source: { kind: "tool", callId: event.data.toolCallId },
            toolCallId: event.data.toolCallId,
            isError: !success,
          },
          ...(success || failure === undefined ? {} : {
            error: {
              name: "ToolError",
              code: textOf(failure.code) || "TOOL_FAILED",
              reason: textOf(failure.message),
            },
          }),
        }, time);
        break;
      }
      case "session.idle":
        closeTurn(time, event.data.aborted === true
          ? { kind: "aborted", reason: { kind: "user" } }
          : { kind: "completed" });
        break;
      default:
        break;
    }
    lastTime = time;
  }
  return drafts.map((draft, index) => ({ ...draft, seq: index }));
}

/** 读取 Codex 会话的原始事件并投影为轨迹页;不附着或启动引擎运行时。 */
export async function readCodexTrajectory(threadId: string, query: DshTrajectoryQuery = {}): Promise<DshTrajectoryPage> {
  assertTrajectoryThreadId(threadId);
  const resolved = resolveTrajectoryQuery(query);
  const revision = await trajectoryRevision(threadId);
  if (resolved.afterSeq !== undefined && resolved.knownRevision === revision) {
    return unchangedTrajectoryPage(revision);
  }
  return trajectoryPage(projectCodexTrajectoryEvents(await loadRawEvents(threadId)), resolved, revision);
}
