// DSH sessionStats 投影的本地等价实现。
//
// 字段与 DSH 内置 `@deepseek-ai/dsh-session-stats` 保持一致，统计口径：
// - turns: 至少关闭过一个 step 的不同 turn；
// - steps: 已关闭的 step（完成/失败/取消都算）；
// - llmMs: step/start → assistant/message；
// - toolMs: tool/call → tool/result（按 callId 配对）；
// - ttftMs/ttftSteps: step/start → 第一个非空 token；
// - decodeMs/decodeTokens: 第一个 token → assistant/message，且 usage 报告 outputTokens。
import type { RuntimeStats } from "@cca/protocol";
import type {
  DshAssistantAttemptData,
  DshAssistantChunkData,
  DshAssistantMessageData,
  DshAssistantStreamRecord,
  DshSessionEvent,
  DshStepEndData,
  DshStepStartData,
  DshStreamChunk,
  DshToolCallData,
  DshToolResultData,
} from "./dshWire.js";

export interface DshStatsState {
  turns: number;
  steps: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  llmMs: number;
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  decodeTokens: number;
  lastTurn: number | null;
  openStep: {
    turn: number;
    step: number;
    startTime: number;
    firstTokenTime: number | null;
  } | null;
  pendingCalls: Record<string, number>;
  updatedAt: number;
}

export function emptyDshStats(): DshStatsState {
  return {
    turns: 0,
    steps: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    lastTurn: null,
    openStep: null,
    pendingCalls: {},
    updatedAt: 0,
  };
}

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** 从持久化的 ThreadMeta 恢复累计值；不完整的旧数据按 0 处理。 */
export function normalizeDshStats(value: RuntimeStats | undefined): DshStatsState {
  if (!value || value.runtime !== "dsh") return emptyDshStats();
  return {
    turns: Math.floor(nonNegative(value.turns)),
    steps: Math.floor(nonNegative(value.steps)),
    inputTokens: nonNegative(value.inputTokens),
    cacheReadTokens: nonNegative(value.cacheReadTokens),
    cacheWriteTokens: nonNegative(value.cacheWriteTokens),
    outputTokens: nonNegative(value.outputTokens),
    llmMs: nonNegative(value.llmMs),
    toolMs: nonNegative(value.toolMs),
    ttftMs: nonNegative(value.ttftMs),
    ttftSteps: Math.floor(nonNegative(value.ttftSteps)),
    decodeMs: nonNegative(value.decodeMs),
    decodeTokens: nonNegative(value.decodeTokens),
    lastTurn:
      typeof value.lastTurn === "number" && Number.isSafeInteger(value.lastTurn) && value.lastTurn >= 0
        ? value.lastTurn
        : null,
    openStep: null,
    pendingCalls: {},
    updatedAt: nonNegative(value.updatedAt),
  };
}

export function dshRuntimeStats(state: DshStatsState): RuntimeStats {
  return {
    runtime: "dsh",
    turns: state.turns,
    steps: state.steps,
    inputTokens: state.inputTokens,
    cacheReadTokens: state.cacheReadTokens,
    cacheWriteTokens: state.cacheWriteTokens,
    outputTokens: state.outputTokens,
    llmMs: state.llmMs,
    toolMs: state.toolMs,
    ttftMs: state.ttftMs,
    ttftSteps: state.ttftSteps,
    decodeMs: state.decodeMs,
    decodeTokens: state.decodeTokens,
    ...(state.lastTurn !== null ? { lastTurn: state.lastTurn } : {}),
    updatedAt: state.updatedAt,
  };
}

function tokenDelta(chunk: DshStreamChunk | undefined): boolean {
  switch (chunk?.type) {
    case "text-delta":
    case "reasoning-delta":
      return chunk.text !== "";
    case "tool-call-delta":
      return chunk.argumentsDelta !== "" || chunk.name !== undefined;
    default:
      return false;
  }
}

function firstRunMemberTime(
  run: Extract<DshAssistantStreamRecord, { time0: number }>,
  fragments: readonly string[],
  predicate: (fragment: string) => boolean,
): number | undefined {
  let time = run.time0;
  for (let index = 0; index < fragments.length; index += 1) {
    if (index > 0) time += nonNegative(run.dt[index - 1]);
    if (predicate(fragments[index]!)) return time;
  }
  return undefined;
}

/** 与 DSH 的 assistantStreamFirstTokenTime 对齐：首个非空 text/reasoning/tool-call delta。 */
export function firstTokenTime(stream: readonly DshAssistantStreamRecord[] | undefined): number | undefined {
  for (const record of stream ?? []) {
    if (record.type === "chunk") {
      if (tokenDelta(record.chunk)) return record.time;
      continue;
    }
    if (record.type === "tool-call-chunks") {
      if (record.name !== undefined) return record.time0;
      const time = firstRunMemberTime(record, record.args, (fragment) => fragment !== "");
      if (time !== undefined) return time;
      continue;
    }
    const time = firstRunMemberTime(record, record.texts, (fragment) => fragment !== "");
    if (time !== undefined) return time;
  }
  return undefined;
}

function outputTokensOf(usage: DshAssistantMessageData["usage"]): number | undefined {
  const value = usage?.outputTokens;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 折叠一条根会话事件；不改变统计的日志事件返回原对象。 */
export function applyDshStatsEvent(state: DshStatsState, event: DshSessionEvent): DshStatsState {
  switch (event.type) {
    case "step/start": {
      const data = event.data as DshStepStartData;
      return {
        ...state,
        openStep: {
          turn: data.turn,
          step: data.step,
          startTime: event.time,
          firstTokenTime: null,
        },
      };
    }
    case "assistant/attempt": {
      const data = event.data as DshAssistantAttemptData;
      const open = state.openStep;
      if (!open || open.turn !== data.turn || open.step !== data.step) return state;
      const first = firstTokenTime(data.stream);
      if (open.firstTokenTime !== null || first === undefined) return state;
      return { ...state, openStep: { ...open, firstTokenTime: first } };
    }
    case "assistant/chunk": {
      // 兼容逐条通知 chunk 的运行时：首个 token 的时间直接来自事件时间。
      const data = event.data as DshAssistantChunkData;
      const open = state.openStep;
      if (!open || open.turn !== data.turn || open.step !== data.step) return state;
      if (open.firstTokenTime !== null || !tokenDelta(data.chunk)) return state;
      return { ...state, openStep: { ...open, firstTokenTime: event.time } };
    }
    case "assistant/message": {
      const data = event.data as DshAssistantMessageData;
      const open = state.openStep;
      if (!open || open.turn !== data.turn || open.step !== data.step) return state;
      const outputTokens = outputTokensOf(data.usage);
      const firstToken = open.firstTokenTime ?? firstTokenTime(data.stream);
      const next: DshStatsState = {
        ...state,
        llmMs: state.llmMs + Math.max(0, event.time - open.startTime),
        inputTokens: state.inputTokens + nonNegative(data.usage?.inputTokens),
        cacheReadTokens: state.cacheReadTokens + nonNegative(data.usage?.cacheReadTokens),
        cacheWriteTokens: state.cacheWriteTokens + nonNegative(data.usage?.cacheWriteTokens),
        outputTokens: state.outputTokens + nonNegative(outputTokens),
        openStep: null,
        updatedAt: event.time,
      };
      if (firstToken !== undefined) {
        next.ttftMs += Math.max(0, firstToken - open.startTime);
        next.ttftSteps += 1;
        if (outputTokens !== undefined) {
          next.decodeMs += Math.max(0, event.time - firstToken);
          next.decodeTokens += outputTokens;
        }
      }
      return next;
    }
    case "tool/call": {
      const data = event.data as DshToolCallData;
      return {
        ...state,
        pendingCalls: { ...state.pendingCalls, [data.callId]: event.time },
      };
    }
    case "tool/result": {
      const data = event.data as DshToolResultData;
      const callId = data.message?.source?.callId ?? data.message?.toolCallId;
      if (!callId || !Object.hasOwn(state.pendingCalls, callId)) return state;
      const dispatched = state.pendingCalls[callId]!;
      const pendingCalls = Object.fromEntries(
        Object.entries(state.pendingCalls).filter(([id]) => id !== callId),
      );
      return {
        ...state,
        toolMs: state.toolMs + Math.max(0, event.time - dispatched),
        pendingCalls,
        updatedAt: event.time,
      };
    }
    case "step/end": {
      const data = event.data as DshStepEndData;
      return {
        ...state,
        turns: state.lastTurn === data.turn ? state.turns : state.turns + 1,
        steps: state.steps + 1,
        lastTurn: data.turn,
        openStep: null,
        updatedAt: event.time,
      };
    }
    case "turn/end": {
      if (Object.keys(state.pendingCalls).length === 0) return state;
      return { ...state, pendingCalls: {} };
    }
    default:
      return state;
  }
}
