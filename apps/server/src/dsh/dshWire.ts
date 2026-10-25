// DeepSeek Harness SDK 运行时（stdio JSON-RPC）的线格式子集。
//
// 形状对照 dsh 0.2.1-rc.2 / @deepseek-ai/dsh-sdk-protocol 0.0.1-rc.1
// 与 @deepseek-ai/dsh-session 0.0.1-rc.5 的 .d.ts。这里只声明应用真正消费的字段，
// 其余事件（agent/inbox、request/*、step/*、system/message 等）按 type 字符串忽略。

// --- 通知（运行时 → 客户端） ---

export interface SessionEventNotification {
  sessionId: string;
  event: DshSessionEvent;
}

export interface SessionStatusNotification {
  sessionId: string;
  status: "idle" | "running";
}

export interface SubagentStartedNotification {
  parentSessionId: string;
  childSessionId: string;
}

export interface SubagentFinishedNotification {
  provider: string;
  agentId: string;
  parentSessionId: string;
  childSessionId: string;
  status: "ok" | "error";
  stopReason: string;
}

// --- 会话事件 ---

export interface DshSessionEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
}

export interface DshTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

// --- 消息与内容块 ---

export interface DshTextBlock {
  type: "text";
  text: string;
}
export interface DshReasoningBlock {
  type: "reasoning";
  text: string;
}
export interface DshImageBlock {
  type: "image";
  attachment?: Record<string, unknown>;
}
export interface DshToolCallBlock {
  type: "tool-call";
  id: string;
  name: string;
  arguments: string;
}
export interface DshToolResultBlock {
  type: "tool-result";
  toolCallId: string;
  content?: DshContentBlock[];
  isError?: boolean;
}
export type DshContentBlock =
  | DshTextBlock
  | DshReasoningBlock
  | DshImageBlock
  | DshToolCallBlock
  | DshToolResultBlock;

export interface DshMessageSource {
  kind: "user" | "model" | "tool" | "agent-instructions" | "runtime-context" | "plugin" | string;
  plugin?: string;
  callId?: string;
  [key: string]: unknown;
}

export interface DshMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: DshContentBlock[];
  source: DshMessageSource;
  /** tool/result 消息在顶层携带调用 id。 */
  toolCallId?: string;
  isError?: boolean;
}

// --- 事件数据 ---

export interface DshTurnStartData {
  turn: number;
}
export interface DshTurnEndData {
  turn: number;
  reason: {
    kind: "completed" | "aborted" | "blocked" | "error" | "max-tokens" | "interrupted";
    reason?: { kind?: string } | string;
    error?: { message?: string };
  };
}
export interface DshUserMessageData {
  /** 0.2.1-rc.2 的 user/message 把消息字段直接放在 data 上；旧格式曾包在 message 里。 */
  message?: DshMessage;
  id?: string;
  role?: "user";
  content?: DshContentBlock[];
  source?: DshMessageSource;
}
export interface DshAssistantMessageData {
  turn: number;
  step: number;
  message: DshMessage;
  usage?: DshTokenUsage;
  /** 本步的原始流式块（0.2.1-rc.2 会随最终消息一起落库，而不是逐条通知）。 */
  stream?: DshAssistantStreamRecord[];
}
export interface DshAssistantAttemptData {
  turn: number;
  step: number;
  stream?: DshAssistantStreamRecord[];
}
export interface DshStepStartData {
  turn: number;
  step: number;
}
export interface DshStepEndData {
  turn: number;
  step: number;
}
export interface DshAssistantChunkData {
  turn: number;
  step: number;
  chunk: DshStreamChunk;
}
export type DshStreamChunk =
  | { type: "block-start"; index: number; blockType: string }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | { type: "tool-call-delta"; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: "block-end"; index: number; block: DshContentBlock }
  | { type: "usage"; usage: DshTokenUsage }
  | { type: "finish"; reason: { kind: string } };

/** 一档打包后的流记录；时间由 time0 + dt 前缀和重建。 */
export type DshPackedStreamRecord =
  | {
      type: "text-chunks" | "reasoning-chunks";
      time0: number;
      index: number;
      dt: number[];
      texts: string[];
    }
  | {
      type: "tool-call-chunks";
      time0: number;
      index: number;
      dt: number[];
      id: string;
      name?: string;
      args: string[];
    };

export type DshAssistantStreamRecord =
  | { type: "chunk"; time: number; chunk: DshStreamChunk }
  | DshPackedStreamRecord;
export interface DshToolCallData {
  turn: number;
  step: number;
  callId: string;
  name: string;
  arguments: string;
}
export interface DshToolResultData {
  turn: number;
  step: number;
  message: DshMessage;
  error?: { name: string; code: string };
  meta?: unknown;
}
