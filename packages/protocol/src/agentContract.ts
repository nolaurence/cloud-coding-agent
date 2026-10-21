// 会话运行时契约（内部化）。
// 历史上这些类型借自 @github/copilot-sdk；迁移 DeepSeek Harness 后由本文件作为单一事实来源，
// 字段只保留应用真实消费/生产的形状（apps/server 的 handleSessionEvent / rebuildHistory / 各工具模块）。

/** 事件信封：每条会话事件的公共字段。 */
export interface SessionEventEnvelope {
  id: string;
  parentId: string | null;
  /** ISO 8601 时间戳。 */
  timestamp: string;
  /** 子代理事件携带宿主 agent id；根会话事件不携带。 */
  agentId?: string;
  ephemeral?: boolean;
}

export interface AssistantTurnStartData {
  turnId: string;
}

export type AssistantTurnEndData = Record<string, never>;

export interface UserMessageData {
  content: string;
  /** 消息来源（skill / jit-instruction 等内部来源会被会话层过滤）。 */
  source?: string;
}

export interface AssistantMessageDeltaData {
  messageId: string;
  deltaContent: string;
}

export interface AssistantReasoningDeltaData {
  reasoningId: string;
  deltaContent: string;
}

export interface AssistantMessageData {
  messageId: string;
  content: string;
  reasoningText?: string;
  turnId?: string;
  /** 图片生成等宿主扩展：随消息归档的附件。 */
  attachments?: unknown[];
}

export interface ToolExecutionStartData {
  toolCallId: string;
  toolName: string;
  arguments?: unknown;
  /** MCP 工具带服务器名/原始工具名（展示为 `server/tool`）。 */
  mcpServerName?: string;
  mcpToolName?: string;
  toolDescription?: { name?: string; description?: string };
}

export interface ToolExecutionCompleteData {
  toolCallId: string;
  toolName?: string;
  success: boolean;
  result?: { content?: string; detailedContent?: string };
  error?: { message: string };
  toolDescription?: { name?: string };
}

export interface SubagentStartedData {
  toolCallId: string;
  agentName: string;
  agentDisplayName: string;
  agentDescription: string;
  model?: string;
  durationMs?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  error?: string;
}

export type SubagentCompletedData = SubagentStartedData;

export type SubagentFailedData = SubagentStartedData;

export type SystemNotificationPayload =
  | { type: "agent_idle"; agentId: string; agentType: string; description?: string }
  | {
      type: "agent_completed";
      agentId: string;
      agentType: string;
      description?: string;
      prompt?: string;
      status?: string;
    };

export interface SystemNotificationData {
  kind: SystemNotificationPayload;
}

export interface SessionUsageInfoData {
  currentTokens: number;
  tokenLimit: number;
}

export interface SessionIdleData {
  aborted: boolean;
}

export interface SessionErrorData {
  message: string;
  errorType?: string;
}

export interface AbortData {
  reason?: string;
}

export type SessionShutdownData = Record<string, never>;

export type SessionEvent =
  | (SessionEventEnvelope & { type: "assistant.turn_start"; data: AssistantTurnStartData })
  | (SessionEventEnvelope & { type: "assistant.turn_end"; data: AssistantTurnEndData })
  | (SessionEventEnvelope & { type: "user.message"; data: UserMessageData })
  | (SessionEventEnvelope & { type: "assistant.message_delta"; data: AssistantMessageDeltaData })
  | (SessionEventEnvelope & { type: "assistant.reasoning_delta"; data: AssistantReasoningDeltaData })
  | (SessionEventEnvelope & { type: "assistant.message"; data: AssistantMessageData })
  | (SessionEventEnvelope & { type: "tool.execution_start"; data: ToolExecutionStartData })
  | (SessionEventEnvelope & { type: "tool.execution_complete"; data: ToolExecutionCompleteData })
  | (SessionEventEnvelope & { type: "subagent.started"; data: SubagentStartedData })
  | (SessionEventEnvelope & { type: "subagent.completed"; data: SubagentCompletedData })
  | (SessionEventEnvelope & { type: "subagent.failed"; data: SubagentFailedData })
  | (SessionEventEnvelope & { type: "system.notification"; data: SystemNotificationData })
  | (SessionEventEnvelope & { type: "session.usage_info"; data: SessionUsageInfoData })
  | (SessionEventEnvelope & { type: "session.idle"; data: SessionIdleData })
  | (SessionEventEnvelope & { type: "session.error"; data: SessionErrorData })
  | (SessionEventEnvelope & { type: "abort"; data: AbortData })
  | (SessionEventEnvelope & { type: "session.shutdown"; data: SessionShutdownData });

export type SessionEventType = SessionEvent["type"];

export type SessionEventData<K extends SessionEventType> = Extract<
  SessionEvent,
  { type: K }
>["data"];

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

export type ToolResultType = "success" | "failure" | "rejected" | "denied" | "timeout";

export type ToolBinaryResult = {
  data: string;
  mimeType: string;
  type: "image" | "resource";
  description?: string;
};

export type ToolResultObject = {
  textResultForLlm: string;
  binaryResultsForLlm?: ToolBinaryResult[];
  resultType: ToolResultType;
  error?: string;
  sessionLog?: string;
  toolTelemetry?: Record<string, Record<string, unknown> | undefined>;
  toolReferences?: string[];
};

export type ToolResult = string | ToolResultObject;

export interface ToolInvocation {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  arguments: unknown;
  traceparent?: string;
  tracestate?: string;
}

export type ToolHandler<TArgs = unknown> = (
  args: TArgs,
  invocation: ToolInvocation,
) => Promise<unknown> | unknown;

export interface Tool<TArgs = unknown> {
  name: string;
  description?: string;
  /** JSON Schema（或带 toJSONSchema() 的 Zod schema）。 */
  parameters?: { toJSONSchema(): Record<string, unknown> } | Record<string, unknown>;
  handler?: ToolHandler<TArgs>;
  overridesBuiltInTool?: boolean;
  skipPermission?: boolean;
  defer?: "auto" | "never";
  metadata?: Record<string, unknown>;
}

/** 与原 SDK defineTool 等价的构造辅助：仅为保留调用点的类型推导。 */
export function defineTool<T = unknown>(
  name: string,
  config: {
    description?: string;
    parameters?: Tool<T>["parameters"];
    handler?: ToolHandler<T>;
    overridesBuiltInTool?: boolean;
    skipPermission?: boolean;
    defer?: "auto" | "never";
    metadata?: Record<string, unknown>;
  },
): Tool<T> {
  return { name, ...config };
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

export interface McpStdioServerConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  workingDirectory?: string;
  /** "*" 表示全部工具；数组表示按名启用。 */
  tools?: string[] | "*";
  timeout?: number;
}

export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
  tools?: string[] | "*";
  timeout?: number;
}

export type MCPServerConfig = McpStdioServerConfig | McpHttpServerConfig;

// ---------------------------------------------------------------------------
// 权限
// ---------------------------------------------------------------------------

/** 运行时权限请求（工具执行前审批）。注意与 UI 层的 PermissionRequest（会话审批卡片）不是同一类型。 */
export type ToolPermissionRequest =
  | { kind: "shell"; serverName?: string; commands?: unknown; sessionId?: string }
  | { kind: "write"; fileName?: string; diff?: string; serverName?: string }
  | { kind: "read"; fileName?: string; serverName?: string }
  | { kind: "mcp"; serverName: string; toolName?: string; args?: unknown }
  | { kind: "url"; url?: string; serverName?: string }
  | { kind: "custom-tool"; toolName: string; args?: unknown }
  | { kind: "memory"; fact?: string }
  | { kind: "hook"; toolName?: string }
  | { kind: "extension-management"; operation?: string }
  | { kind: "extension-permission-access"; extensionName?: string; capabilities?: string[] };

export type PermissionRequestResult =
  | { kind: "approve-once" }
  | { kind: "approve-for-session" }
  | { kind: "reject"; feedback?: string }
  | { kind: "no-result" };

export type PermissionHandler = (
  request: ToolPermissionRequest,
  invocation: { sessionId: string },
) => Promise<PermissionRequestResult> | PermissionRequestResult;

// ---------------------------------------------------------------------------
// 会话配置
// ---------------------------------------------------------------------------

export interface SystemMessageConfig {
  mode: "append" | "replace";
  content: string;
}

export interface ModelCapabilitiesOverride {
  limits?: {
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface SessionProviderConfig {
  type: "openai" | "azure" | "anthropic";
  baseUrl: string;
  apiKey?: string;
  maxPromptTokens?: number;
  wireApi?: "completions" | "responses";
  headers?: Record<string, string>;
  azure?: { apiVersion: string };
}

export interface MessageOptions {
  prompt: string;
  attachments?: { type: "file"; path: string; displayName?: string }[];
}

export interface SessionConfigBase {
  sessionId?: string;
  workingDirectory?: string;
  streaming?: boolean;
  includeSubAgentStreamingEvents?: boolean;
  enableConfigDiscovery?: boolean;
  requestExtensions?: boolean;
  enableFileHooks?: boolean;
  enableSessionStore?: boolean;
  skipEmbeddingRetrieval?: boolean;
  embeddingCacheStorage?: string;
  memory?: { enabled: boolean };
  systemMessage?: SystemMessageConfig;
  model?: string;
  reasoningEffort?: string;
  modelCapabilities?: ModelCapabilitiesOverride;
  provider?: SessionProviderConfig;
  tools?: Tool[];
  availableTools?: Tool[];
  mcpServers?: Record<string, MCPServerConfig>;
  skillDirectories?: string[];
  disabledSkills?: string[];
  enableSkills?: boolean;
  pluginDirectories?: string[];
  customAgents?: unknown[];
  onPermissionRequest?: PermissionHandler;
  [key: string]: unknown;
}

export interface SessionConfig extends SessionConfigBase {
  sessionId?: string;
}

export interface ResumeSessionConfig extends SessionConfigBase {
  sessionId: string;
}

// ---------------------------------------------------------------------------
// 模型信息
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  name: string;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
  capabilities: {
    supports: { reasoningEffort?: boolean; [key: string]: unknown };
    limits?: { max_context_window_tokens?: number; [key: string]: unknown };
    [key: string]: unknown;
  };
}

// ---------------------------------------------------------------------------
// 上下文压缩
// ---------------------------------------------------------------------------

export interface HistoryCompactResult {
  success: boolean;
  tokensRemoved: number;
  messagesRemoved: number;
  summaryContent?: string;
  contextWindow?: { currentTokens: number; tokenLimit: number };
}
