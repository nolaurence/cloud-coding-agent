// DeepSeek Harness SDK 运行时协议的线格式类型（stdio JSON-RPC）。
// 形状镜像自 @deepseek-ai/dsh-sdk-protocol@0.0.1-rc.1 / @deepseek-ai/dsh-session / @deepseek-ai/dsh-llm，
// 只声明本应用消费的字段；升级 DSH 依赖时对照其 .d.ts 校验本文件。

// --- 通知（服务端 → 客户端） ---

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
  lastAssistantMessage?: DshContentBlock[];
}

export interface HarnessSdkNotificationMap {
  "session.event": SessionEventNotification;
  "session.status": SessionStatusNotification;
  "subagent.started": SubagentStartedNotification;
  "subagent.finished": SubagentFinishedNotification;
}

export type HarnessNotificationMethod = keyof HarnessSdkNotificationMap;

// --- 会话事件（dsh-session 的 SessionEvent 子集） ---

export type DshSessionEvent =
  | { type: "turn/start"; seq: number; time: number; data: { turn: number } }
  | { type: "turn/end"; seq: number; time: number; data: { turn: number; reason: DshTurnEndReason } }
  | { type: "step/start"; seq: number; time: number; data: { turn: number; step: number } }
  | { type: "step/end"; seq: number; time: number; data: { turn: number; step: number } }
  | { type: "user/message"; seq: number; time: number; data: DshUserMessage }
  | { type: "assistant/chunk"; seq: number; time: number; data: { turn: number; step: number; chunk: DshStreamChunk } }
  | { type: "assistant/message"; seq: number; time: number; data: { turn: number; step: number; message: DshAssistantMessage; usage?: DshTokenUsage } }
  | { type: "tool/call"; seq: number; time: number; data: { turn: number; step: number; callId: string; name: string; arguments: string } }
  | { type: "tool/result"; seq: number; time: number; data: { turn: number; step: number; message: DshToolResultMessage; error?: { name: string; code: string }; meta?: unknown } }
  | { type: "todo/write"; seq: number; time: number; data: { todos: { content: string; status: string }[] } }
  | { type: "request/header"; seq: number; time: number; data: Record<string, unknown> }
  | { type: "request/context"; seq: number; time: number; data: { provider: string; model: string; contextWindow?: number } }
  | { type: "session/end-seed"; seq: number; time: number; data: Record<string, never> };

export interface DshTurnEndReason {
  kind: "completed" | "aborted" | "blocked" | "error" | "max-tokens" | "interrupted";
  reason?: { kind?: string } | string;
  error?: { message?: string };
}

// --- 消息与内容块（dsh-llm 的子集） ---

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
  attachment: Record<string, unknown>;
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
  content: DshContentBlock[];
  isError?: boolean;
}
export type DshContentBlock =
  | DshTextBlock
  | DshReasoningBlock
  | DshImageBlock
  | DshToolCallBlock
  | DshToolResultBlock;

export interface DshMessageSource {
  kind: "user" | "plugin" | "model" | "tool" | string;
  plugin?: string;
  [key: string]: unknown;
}

export interface DshUserMessage {
  id: string;
  role: "user";
  content: DshContentBlock[];
  source: DshMessageSource;
}

export interface DshAssistantMessage {
  id: string;
  role: "assistant";
  content: DshContentBlock[];
  source: DshMessageSource;
}

export interface DshToolResultMessage {
  id: string;
  role: "user";
  content: [DshToolResultBlock];
  source: DshMessageSource & { kind: "tool"; callId: string };
}

export interface DshTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export type DshStreamChunk =
  | { type: "block-start"; index: number; blockType: string }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | { type: "tool-call-delta"; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: "block-end"; index: number; block: DshContentBlock }
  | { type: "usage"; usage: DshTokenUsage }
  | { type: "finish"; reason: { kind: string }; replayState?: unknown };

// --- 客户端 → 服务端请求 ---

export interface DshInitializeParams {
  cwd: string;
  provider: string;
  model: string;
  maxTokens?: number;
}

export interface DshInitializeResult {
  serverInfo: { name: string; version: string };
}

export interface DshSessionPromptParams {
  sessionId: string;
  contentBlocks: DshContentBlock[];
}

export interface DshSessionPromptResult {
  messageId: string;
}
