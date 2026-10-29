export type WireApi = "completions" | "responses";
export type ProviderType = "openai" | "azure" | "anthropic";
export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORTS.includes(value as ReasoningEffort);
}

export function normalizeReasoningEfforts(
  values: readonly unknown[] | undefined,
): ReasoningEffort[] | undefined {
  if (!values) return undefined;
  return [...new Set(values.filter(isReasoningEffort))];
}

const LEGACY_REASONING_EFFORTS: readonly ReasoningEffort[] = ["low", "medium", "high", "xhigh"];

// Existing provider configs may only contain IDs; discovered/runtime metadata still takes precedence.
const KNOWN_MODEL_REASONING_EFFORTS: Readonly<Record<string, readonly ReasoningEffort[]>> = {
  "gpt-5.4": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5.5": ["none", "low", "medium", "high", "xhigh"],
  "gpt-5.6-sol": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-luna": ["none", "low", "medium", "high", "xhigh", "max"],
  "gpt-5.6-terra": ["none", "low", "medium", "high", "xhigh", "max"],
  "k3": ["low", "high", "max"],
  "k3-256k": ["low", "high", "max"],
};

const KNOWN_MODEL_CONTEXT_WINDOW_TOKENS: Readonly<Record<string, number>> = {
  "gpt-5.6-sol": 258_000,
};

export function normalizeContextWindowTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export interface ModelEntry {
  id: string;
  name?: string;
  contextWindowTokens?: number;
  reasoningEffort?: boolean;
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export interface ModelProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  wireApi?: WireApi;
  azureApiVersion?: string;
  models: ModelEntry[];
}

export type ProviderModelDiscoveryConfig = Pick<
  ModelProviderConfig,
  "type" | "baseUrl" | "apiKey" | "azureApiVersion"
>;

export type ResourceScope = "platform" | "workspace";

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  type: "local" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  tools: string[];
  timeout?: number;
}

export type ConnectorPlatform = "qq" | "feishu";
export type ConnectorConnectionState =
  | "disabled"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface ConnectorConfig {
  id: string;
  name: string;
  platform: ConnectorPlatform;
  enabled: boolean;
  /** 访问域名为 pre 前缀时新建的连接器默认进入预发环境；旧配置按线上处理。 */
  preRelease?: boolean;
  appId: string;
  appSecret: string;
  projectId: string;
  model: ModelRef;
  allowedUserIds?: string[];
  ownerId?: string;
}

export interface ConnectorStatus {
  id: string;
  state: ConnectorConnectionState;
  message?: string;
  updatedAt: number;
}

export interface AppSettings {
  providers: ModelProviderConfig[];
  defaultModel?: ModelRef;
  /** Defaults to true for existing configurations. */
  imageGenerationEnabled?: boolean;
  connectors: ConnectorConfig[];
  mcpServers: McpServerConfig[];
  skillDirectories: string[];
  disabledSkills: string[];
}

export const DEFAULT_MODEL_PROVIDER_ID = "codex";

/** 会话执行引擎：Codex app-server 或 DeepSeek Harness 运行时。 */
export const AGENT_RUNTIMES = ["codex", "dsh"] as const;
export type AgentRuntime = (typeof AGENT_RUNTIMES)[number];
export const DEFAULT_AGENT_RUNTIME: AgentRuntime = "codex";

export function isAgentRuntime(value: unknown): value is AgentRuntime {
  return typeof value === "string" && AGENT_RUNTIMES.includes(value as AgentRuntime);
}

export interface ModelRef {
  providerId: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
}

export const AGENT_MODES = ["standard", "ultra"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export function isAgentMode(value: unknown): value is AgentMode {
  return typeof value === "string" && AGENT_MODES.includes(value as AgentMode);
}

export const PERMISSION_MODES = ["request", "auto", "full"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && PERMISSION_MODES.includes(value as PermissionMode);
}

export type PermissionRequestKind = "command" | "file" | "permissions";

export interface PermissionRequest {
  requestId: string;
  kind: PermissionRequestKind;
  command?: string;
  cwd?: string;
  reason?: string;
}

export const PERMISSION_DECISIONS = ["accept", "decline"] as const;
export type PermissionDecision = (typeof PERMISSION_DECISIONS)[number];

export function isPermissionDecision(value: unknown): value is PermissionDecision {
  return (
    typeof value === "string" &&
    PERMISSION_DECISIONS.includes(value as PermissionDecision)
  );
}

export function resolveModelContextWindowTokens(
  settings: AppSettings,
  model: ModelRef | undefined,
): number | undefined {
  if (!model) return undefined;
  const configured = settings.providers
    .find((provider) => provider.id === model.providerId)
    ?.models.find((entry) => entry.id === model.modelId)?.contextWindowTokens;
  return (
    normalizeContextWindowTokens(configured) ??
    KNOWN_MODEL_CONTEXT_WINDOW_TOKENS[model.modelId.trim().toLowerCase()]
  );
}

export interface ModelOption {
  ref: ModelRef;
  label: string;
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  ownerId: string;
}

export type Workspace = Pick<Project, "id" | "name">;

export type UserRole = "admin" | "user";
export type ThreadShareMode = "readonly" | "collaborate";
export type ThreadAccess = "owner" | ThreadShareMode;

export interface AdminUser {
  username: string;
  role: UserRole;
  createdAt: number;
  protected: boolean;
}

export interface RegistrationPolicy {
  inviteRequired: boolean;
}

export interface InviteSummary {
  id: string;
  hint: string;
  createdBy: string;
  createdAt: number;
}

export interface AdminRegistrationState extends RegistrationPolicy {
  invites: InviteSummary[];
}

export interface CreatedInvite extends InviteSummary {
  code: string;
}

export interface ThreadShareSummary {
  active: boolean;
  mode?: ThreadShareMode;
  createdAt?: number;
  memberCount: number;
}

export interface CreatedThreadShare extends ThreadShareSummary {
  token: string;
}

export interface ThreadSharePreview {
  thread: ThreadMeta;
  mode: ThreadShareMode;
}

export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
}

/**
 * 运行时累计统计（当前由 DSH 提供）。
 * 字段语义与 DSH 的 sessionStats 投影一致：token 计数是全程累计，
 * decode 只统计有首 token 且报告 usage 的 step。
 */
export interface RuntimeStats {
  runtime: AgentRuntime;
  /** 至少关闭过一个 step 的不同 turn 数。 */
  turns: number;
  /** 已关闭的 step 数（完成、失败、取消都计）。 */
  steps: number;
  /** 未命中缓存的输入 token。 */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  /** step/start → assistant/message 的累计模型用时。 */
  llmMs: number;
  /** tool/call → tool/result 的累计工具用时。 */
  toolMs: number;
  ttftMs: number;
  ttftSteps: number;
  decodeMs: number;
  decodeTokens: number;
  /** 仅用于跨进程恢复时避免同一 turn 被重复计数。 */
  lastTurn?: number;
  updatedAt: number;
}

export interface ContextCompactionResult {
  tokensRemoved: number;
  messagesRemoved: number;
  contextUsage?: ContextUsage;
}

export interface ThreadMeta {
  overview?: ThreadOverviewAnnotations;
  runtime?: AgentRuntime;
  id: string;
  projectId: string;
  title: string;
  model?: ModelRef;
  modelProviderId?: string;
  agentMode?: AgentMode;
  permissionMode?: PermissionMode;
  userId?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  contextUsage?: ContextUsage;
  runtimeStats?: RuntimeStats;
  access?: ThreadAccess;
  shared?: boolean;
  messageAttachments?: Record<string, MessageAttachment[]>;
  messageAuthors?: Record<string, string>;
  connector?: {
    connectorId: string;
    platform: ConnectorPlatform;
    conversationId: string;
  };
}

export interface ThreadCreateResult extends ThreadMeta {
  initialTurnAccepted?: true;
}

export function resolveThreadModelProviderId(
  thread: Pick<ThreadMeta, "model" | "modelProviderId"> | undefined,
  defaultModel?: ModelRef,
): string {
  return (
    thread?.modelProviderId ??
    thread?.model?.providerId ??
    defaultModel?.providerId ??
    DEFAULT_MODEL_PROVIDER_ID
  );
}

export function resolveThreadModel(
  thread: Pick<ThreadMeta, "model" | "modelProviderId"> | undefined,
  defaultModel?: ModelRef,
): ModelRef | undefined {
  const providerId = resolveThreadModelProviderId(thread, defaultModel);
  if (thread?.model?.providerId === providerId) return thread.model;
  return defaultModel?.providerId === providerId ? defaultModel : undefined;
}

export interface AuthUser {
  username: string;
  role: UserRole;
}

export interface ThreadOverviewNote {
  id: string;
  text: string;
  pinned: boolean;
  sourceTurnId?: string;
}

export interface ThreadOverviewAnnotations {
  goal?: string;
  notes: ThreadOverviewNote[];
}

export interface RuntimeResources {
  scope: "pod" | "container" | "host" | "unavailable";
  name?: string;
  cpuCores: number | null;
  cpuLimitCores: number | null;
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryLimitBytes: number | null;
  memoryPercent: number | null;
  sampledAt: number;
  source: string;
  notice?: string;
}

export interface PluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

/**
 * 插件清单的遵循程度:严格通过 Agent Plugins 1.0.0 校验,或按兼容模式解析
 * (旧的 Claude/Codex/Copilot 插件目录,未声明 `$schema`)。
 */
export type PluginConformance = "agent-plugins-1.0.0" | "compat";

export interface PluginSkillInfo {
  name: string;
  description: string;
  /** 相对插件根目录的路径,便于在 UI 中定位。 */
  path: string;
  valid: boolean;
  error?: string;
}

export interface PluginMcpServerInfo {
  id: string;
  transport: "stdio" | "streamable-http" | "sse";
  label: string;
  valid: boolean;
  error?: string;
}

export interface InstalledPlugin {
  /** 插件标识:Agent Plugins 的 manifest.name(兼容模式会规整为小写 kebab-case)。 */
  name: string;
  /** 清单里的原始名称,兼容模式下可能与 name 不同。 */
  displayName?: string;
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords: string[];
  /** 安装来源:git 地址、本地路径或 builtin:<id>。 */
  source: string;
  subdirectory?: string;
  installedAt: number;
  enabled: boolean;
  conformance: PluginConformance;
  skills: PluginSkillInfo[];
  mcpServers: PluginMcpServerInfo[];
  /** 非致命问题:未知顶层字段、被跳过的组件等。 */
  warnings: string[];
  /** 插件被判定为无效时的原因,此时不会加载任何组件。 */
  error?: string;
}

export interface PluginMarketplace {
  id: string;
  name: string;
  description?: string;
  /** 内置市场为 builtin,远程市场为清单 URL。 */
  source: string;
  kind: "builtin" | "remote";
  pluginCount: number;
}

export interface MarketplacePlugin {
  id: string;
  marketplaceId: string;
  name: string;
  description: string;
  /** 传给 plugins.install 的来源。 */
  source: string;
  subdirectory?: string;
  version?: string;
  author?: string;
  homepage?: string;
  license?: string;
  tags: string[];
  category: string;
  /** 市场条目自述的遵循程度;未知时省略,安装后再判定。 */
  conformance?: PluginConformance;
  installed?: boolean;
}

export interface PluginInstallResult {
  plugin: InstalledPlugin;
  skillsInstalled: number;
  warnings: string[];
}

export interface SkillInfo {
  name: string;
  description: string;
  directory: string;
  content: string;
  disabled: boolean;
  builtin: boolean;
  scope: ResourceScope;
  /** 由插件提供时,这里是插件名;插件技能只读,随插件启停。 */
  plugin?: string;
}

export interface ShellState {
  projects: Workspace[];
  threads: ThreadMeta[];
  runningThreadIds: string[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  authorId?: string;
  attachments?: MessageAttachment[];
  reasoning?: string;
  streaming?: boolean;
  turnId: string;
  createdAt: number;
}

export interface MessageAttachment {
  id: string;
  displayName: string;
  kind: "image" | "file";
  ownerId: string;
}

export interface TurnAttachment {
  path: string;
  displayName?: string;
  imageId?: string;
  fileId?: string;
}

export interface ProjectFileEntry {
  path: string;
  kind: "file" | "directory";
}

export interface ProjectDirectoryEntry extends ProjectFileEntry {
  name: string;
  size?: number;
  modifiedAt: number;
}

export interface ProjectDirectoryListing {
  path: string;
  entries: ProjectDirectoryEntry[];
}

export interface ProjectFileContent {
  path: string;
  content: string;
  size: number;
  modifiedAt: number;
  version: string;
}

export interface ProjectFileWriteResult {
  path: string;
  size: number;
  modifiedAt: number;
  version: string;
}

export interface WordDocumentPreview {
  kind: "word";
  path: string;
  paragraphs: string[];
}

export interface SpreadsheetDocumentPreview {
  kind: "excel";
  path: string;
  sheets: Array<{ name: string; rows: string[][] }>;
}

export interface PresentationDocumentPreview {
  kind: "powerpoint";
  path: string;
  slides: Array<{ index: number; text: string[] }>;
}

export type DocumentPreview =
  | WordDocumentPreview
  | SpreadsheetDocumentPreview
  | PresentationDocumentPreview;

export interface GitDiffResult {
  patch: string;
  files: number;
  additions: number;
  deletions: number;
  truncated: boolean;
  branch?: string;
  untracked: number;
  untrackedFiles: string[];
}

export interface GitCommitResult {
  hash: string;
  summary: string;
}

export type GitFileStatus = "M" | "A" | "D" | "R" | "C" | "U" | "?";

export interface GitFileChange {
  path: string;
  oldPath?: string;
  staged?: GitFileStatus;
  unstaged?: GitFileStatus;
}

export interface GitWorkspaceStatus {
  head: string | null;
  indexTree: string;
  branch?: string;
  detached: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFileChange[];
}

export interface GitLogCommit {
  hash: string;
  shortHash: string;
  parents: string[];
  author: string;
  email: string;
  date: number;
  subject: string;
  refs: string[];
}

export interface GitLogResult {
  commits: GitLogCommit[];
  hasMore: boolean;
}

export interface GitFileDiffResult {
  path: string;
  staged: boolean;
  patch: string;
  truncated: boolean;
}

export interface GitCommitDiffResult {
  hash: string;
  patch: string;
  truncated: boolean;
}

export interface GitCommitMessageResult {
  message: string;
  truncated: boolean;
}

export type GitProvider = "github" | "gitee";

export interface GitBinding {
  provider: GitProvider;
  username: string;
  avatarUrl?: string;
  profileUrl: string;
  connectedAt: number;
}

export interface TerminalSnapshot {
  terminalId: string;
  cwd: string;
  history: string;
  running: boolean;
  cols: number;
  rows: number;
}

export type TerminalEvent =
  | ({ kind: "opened" } & TerminalSnapshot)
  | { kind: "output"; terminalId: string; data: string }
  | { kind: "exit"; terminalId: string; code: number | null; signal?: number };

export interface ToolActivity {
  id: string;
  turnId: string;
  toolName: string;
  status: "running" | "complete" | "error";
  args?: string;
  result?: string;
  startedAt: number;
  endedAt?: number;
}

export interface SubagentMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  reasoning?: string;
  createdAt: number;
}

export interface SubagentActivity {
  id: string;
  turnId: string;
  parentAgentId?: string;
  toolCallId: string;
  agentName: string;
  agentDisplayName: string;
  agentDescription: string;
  taskDescription?: string;
  prompt?: string;
  model?: string;
  status: "running" | "idle" | "complete" | "error" | "cancelled";
  messages: SubagentMessage[];
  activities: ToolActivity[];
  startedAt: number;
  idleSince?: number;
  endedAt?: number;
  durationMs?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  error?: string;
  live?: {
    messageId?: string;
    text: string;
    reasoning: string;
    startedAt: number;
  };
}

export interface TurnInput {
  text: string;
  attachments?: TurnAttachment[];
}

/** Original durable DSH envelope; additional native fields remain on the wire. */
export interface DshTrajectoryEvent {
  seq: number;
  time: number;
  type: string;
  data: unknown;
}

export interface DshTrajectoryPage {
  events: DshTrajectoryEvent[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  revision: string;
  unchanged?: boolean;
}

export interface DshTrajectoryQuery {
  beforeSeq?: number;
  afterSeq?: number;
  limit?: number;
  knownRevision?: string;
}

export type ThreadEvent =
  | {
      kind: "snapshot";
      messages: ChatMessage[];
      activities: ToolActivity[];
      subagents?: SubagentActivity[];
      running: boolean;
      contextUsage?: ContextUsage;
      runtimeStats?: RuntimeStats;
      error?: string;
      live?: { text: string; reasoning: string; turnId: string; startedAt: number };
      pendingPermission?: PermissionRequest;
    }
  | { kind: "turn.start"; turnId: string }
  | { kind: "turn.end"; turnId: string }
  | { kind: "user.message"; message: ChatMessage }
  | { kind: "assistant.delta"; messageId: string; turnId: string; delta: string }
  | { kind: "assistant.reasoning_delta"; messageId: string; turnId: string; delta: string }
  | { kind: "assistant.message"; message: ChatMessage }
  | { kind: "tool.start"; activity: ToolActivity }
  | { kind: "tool.complete"; activity: ToolActivity }
  | { kind: "subagent.update"; subagent: SubagentActivity }
  | {
      kind: "subagent.message_delta";
      subagentId: string;
      messageId: string;
      delta: string;
      startedAt: number;
    }
  | {
      kind: "subagent.reasoning_delta";
      subagentId: string;
      delta: string;
      startedAt: number;
    }
  | { kind: "context.usage"; usage?: ContextUsage }
  | { kind: "runtime.stats"; stats?: RuntimeStats }
  | { kind: "permission.request"; request: PermissionRequest }
  | { kind: "permission.resolve"; requestId: string; decision: PermissionDecision }
  | { kind: "error"; message: string }
  | { kind: "title"; title: string };

export type ClientMessage =
  | { id: string; type: "shell.subscribe" }
  | { id: string; type: "workspace.create"; name: string; path?: string }
  | { id: string; type: "workspace.remove"; projectId: string }
  | {
      id: string;
      type: "thread.create";
      projectId: string;
      model?: ModelRef;
      agentMode?: AgentMode;
      permissionMode?: PermissionMode;
      runtime?: AgentRuntime;
      initialTurn?: TurnInput;
    }
  | { id: string; type: "thread.delete"; threadId: string }
  | { id: string; type: "thread.setModel"; threadId: string; model: ModelRef }
  | { id: string; type: "thread.overview.update"; threadId: string; overview: ThreadOverviewAnnotations }
  | { id: string; type: "runtime.resources"; threadId: string }
  | { id: string; type: "thread.setAgentMode"; threadId: string; agentMode: AgentMode }
  | {
      id: string;
      type: "thread.setPermissionMode";
      threadId: string;
      permissionMode: PermissionMode;
    }
  | {
      id: string;
      type: "permission.respond";
      threadId: string;
      requestId: string;
      decision: PermissionDecision;
    }
  | ({ id: string; type: "thread.trajectory.load"; threadId: string } & DshTrajectoryQuery)
  | { id: string; type: "thread.subscribe"; threadId: string }
  | { id: string; type: "thread.unsubscribe"; threadId: string }
  | { id: string; type: "thread.share.get"; threadId: string }
  | { id: string; type: "thread.share.create"; threadId: string; mode: ThreadShareMode }
  | { id: string; type: "thread.share.revoke"; threadId: string }
  | { id: string; type: "thread.share.preview"; token: string }
  | { id: string; type: "thread.share.redeem"; token: string }
  | { id: string; type: "turn.start"; threadId: string; text: string; attachments?: TurnAttachment[] }
  | { id: string; type: "turn.interrupt"; threadId: string }
  | { id: string; type: "thread.compact"; threadId: string }
  | { id: string; type: "settings.get" }
  | { id: string; type: "settings.update"; settings: AppSettings }
  | { id: string; type: "connectors.status" }
  | { id: string; type: "skills.list" }
  | { id: string; type: "mcp.list" }
  | { id: string; type: "mcp.save"; server: McpServerConfig }
  | { id: string; type: "mcp.delete"; idToDelete: string }
  | { id: string; type: "skill.save"; name: string; description: string; content: string }
  | { id: string; type: "skill.delete"; name: string }
  | { id: string; type: "plugins.marketplaces.list" }
  | { id: string; type: "plugins.marketplace.add"; source: string }
  | { id: string; type: "plugins.marketplace.remove"; marketplaceId: string }
  | { id: string; type: "plugins.marketplace.browse"; marketplaceId: string }
  | { id: string; type: "plugins.list" }
  | { id: string; type: "plugins.install"; source: string; subdirectory?: string }
  | { id: string; type: "plugins.uninstall"; name: string }
  | { id: string; type: "plugins.setEnabled"; name: string; enabled: boolean }
  | { id: string; type: "models.list" }
  | { id: string; type: "provider.models.discover"; provider: ProviderModelDiscoveryConfig }
  | { id: string; type: "files.search"; projectId: string; query: string }
  | { id: string; type: "project.files"; projectId: string }
  | { id: string; type: "project.directory.list"; projectId: string; path?: string }
  | { id: string; type: "project.file.read"; projectId: string; path: string }
  | { id: string; type: "project.document.preview"; projectId: string; path: string }
  | {
      id: string;
      type: "project.file.write";
      threadId: string;
      projectId: string;
      path: string;
      content: string;
      expectedVersion: string;
    }
  | { id: string; type: "project.diff"; projectId: string }
  | { id: string; type: "project.git.status"; projectId: string; directory?: string }
  | { id: string; type: "project.git.log"; projectId: string; directory?: string; limit?: number; query?: string }
  | { id: string; type: "project.git.commitDiff"; projectId: string; directory?: string; hash: string }
  | { id: string; type: "project.git.fileDiff"; projectId: string; directory?: string; path: string; staged: boolean }
  | {
      id: string;
      type: "project.git.generateCommitMessage";
      threadId: string;
      projectId: string;
      directory?: string;
      expectedHead: string | null;
      expectedIndexTree: string;
    }
  | {
      id: string;
      type: "project.git.stage" | "project.git.unstage";
      threadId: string;
      projectId: string;
      directory?: string;
      paths: string[];
      expectedHead: string | null;
      expectedIndexTree: string;
    }
  | { id: string; type: "project.git.pull"; threadId: string; projectId: string; directory?: string }
  | { id: string; type: "project.git.push"; threadId: string; projectId: string; directory?: string }
  | {
      id: string;
      type: "project.git.commit";
      threadId: string;
      projectId: string;
      directory?: string;
      message: string;
      stageAll?: boolean;
      expectedHead?: string | null;
      expectedIndexTree?: string;
    }
  | {
      id: string;
      type: "terminal.open";
      threadId: string;
      /** 新对话还没有会话时，用已选工作区打开终端。 */
      projectId?: string;
      terminalId: string;
      cols?: number;
      rows?: number;
    }
  | { id: string; type: "terminal.write"; terminalId: string; data: string }
  | { id: string; type: "terminal.resize"; terminalId: string; cols: number; rows: number }
  | { id: string; type: "terminal.close"; terminalId: string }
  | { id: string; type: "git.bindings" }
  | { id: string; type: "git.bind"; provider: GitProvider; token: string }
  | { id: string; type: "git.unbind"; provider: GitProvider };

export type ServerMessage =
  | { type: "reply"; id: string; ok: true; data?: unknown }
  | { type: "reply"; id: string; ok: false; error: string }
  | { type: "auth.error"; message: string }
  | { type: "auth.user"; user: AuthUser }
  | { type: "shell"; data: ShellState }
  | { type: "settings"; data: AppSettings }
  | { type: "connectors.status"; data: ConnectorStatus[] }
  | { type: "skills"; data: SkillInfo[] }
  | { type: "terminal.event"; event: TerminalEvent }
  | { type: "thread.event"; threadId: string; event: ThreadEvent };

export const DEFAULT_SETTINGS: AppSettings = {
  providers: [],
  imageGenerationEnabled: true,
  connectors: [],
  mcpServers: [],
  skillDirectories: [],
  disabledSkills: [],
};

export function flattenModels(
  settings: AppSettings,
  capabilityModels: readonly ModelOption[] = [],
): ModelOption[] {
  const capabilitiesByModelId = new Map<string, ModelOption>();
  for (const model of capabilityModels) {
    if (model.supportedReasoningEfforts === undefined) continue;
    capabilitiesByModelId.set(model.ref.modelId, model);
  }

  const out: ModelOption[] = [];
  for (const p of settings.providers) {
    for (const m of p.models) {
      const catalogCapabilities = capabilitiesByModelId.get(m.id);
      const configuredEfforts = normalizeReasoningEfforts(m.supportedReasoningEfforts);
      const knownEfforts = KNOWN_MODEL_REASONING_EFFORTS[m.id.toLowerCase()];
      const supportedReasoningEfforts =
        configuredEfforts ??
        (m.reasoningEffort === false
          ? []
          : catalogCapabilities?.supportedReasoningEfforts ??
            (knownEfforts
              ? [...knownEfforts]
              : m.reasoningEffort === true
                ? [...LEGACY_REASONING_EFFORTS]
                : undefined));
      const defaultReasoningEffort =
        m.defaultReasoningEffort ?? catalogCapabilities?.defaultReasoningEffort;

      out.push({
        ref: { providerId: p.id, modelId: m.id },
        label: `${p.name} / ${m.name ?? m.id}`,
        supportedReasoningEfforts,
        defaultReasoningEffort:
          defaultReasoningEffort && supportedReasoningEfforts?.includes(defaultReasoningEffort)
            ? defaultReasoningEffort
            : undefined,
      });
    }
  }
  return out;
}

export function normalizeModelRefReasoning(
  model: ModelRef,
  modelOptions: readonly ModelOption[],
): ModelRef {
  if (!model.reasoningEffort) return model;
  const option = modelOptions.find(
    (candidate) =>
      candidate.ref.providerId === model.providerId && candidate.ref.modelId === model.modelId,
  );
  if (
    !option ||
    option.supportedReasoningEfforts === undefined ||
    option.supportedReasoningEfforts.includes(model.reasoningEffort)
  ) {
    return model;
  }

  const { reasoningEffort: _reasoningEffort, ...normalized } = model;
  return normalized;
}

export function normalizeConfiguredModelRef(settings: AppSettings, model: ModelRef): ModelRef {
  return normalizeModelRefReasoning(model, flattenModels(settings));
}
