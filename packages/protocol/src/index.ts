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
};

export interface ModelEntry {
  id: string;
  name?: string;
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

export interface AppSettings {
  providers: ModelProviderConfig[];
  defaultModel?: ModelRef;
  mcpServers: McpServerConfig[];
  skillDirectories: string[];
  disabledSkills: string[];
}

export interface ModelRef {
  providerId: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
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
}

export interface DirectoryBrowseEntry {
  name: string;
  fullPath: string;
}

export interface DirectoryBrowseResult {
  parentPath: string;
  entries: DirectoryBrowseEntry[];
}

export interface ThreadMeta {
  id: string;
  projectId: string;
  title: string;
  model?: ModelRef;
  userId?: string;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
  messageAttachments?: Record<string, MessageAttachment[]>;
}

export interface AuthUser {
  username: string;
  role: "admin" | "user";
}

export interface SkillInfo {
  name: string;
  description: string;
  directory: string;
  content: string;
  disabled: boolean;
  builtin: boolean;
}

export interface ShellState {
  projects: Project[];
  threads: ThreadMeta[];
  runningThreadIds: string[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  attachments?: MessageAttachment[];
  reasoning?: string;
  streaming?: boolean;
  turnId: string;
  createdAt: number;
}

export interface MessageAttachment {
  id: string;
  displayName: string;
  kind: "image";
  ownerId: string;
}

export interface TurnAttachment {
  path: string;
  displayName?: string;
  imageId?: string;
}

export interface ProjectFileEntry {
  path: string;
  kind: "file" | "directory";
}

export interface ProjectFileContent {
  path: string;
  content: string;
  size: number;
}

export interface GitDiffResult {
  patch: string;
  files: number;
  additions: number;
  deletions: number;
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

export type TerminalEvent =
  | { kind: "opened"; terminalId: string; cwd: string; history: string; running: boolean }
  | { kind: "output"; terminalId: string; data: string }
  | { kind: "exit"; terminalId: string; code: number | null };

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

export type ThreadEvent =
  | {
      kind: "snapshot";
      messages: ChatMessage[];
      activities: ToolActivity[];
      running: boolean;
      live?: { text: string; reasoning: string; turnId: string; startedAt: number };
    }
  | { kind: "turn.start"; turnId: string }
  | { kind: "turn.end"; turnId: string }
  | { kind: "user.message"; message: ChatMessage }
  | { kind: "assistant.delta"; messageId: string; turnId: string; delta: string }
  | { kind: "assistant.reasoning_delta"; messageId: string; turnId: string; delta: string }
  | { kind: "assistant.message"; message: ChatMessage }
  | { kind: "tool.start"; activity: ToolActivity }
  | { kind: "tool.complete"; activity: ToolActivity }
  | { kind: "error"; message: string }
  | { kind: "title"; title: string };

export type ClientMessage =
  | { id: string; type: "shell.subscribe" }
  | { id: string; type: "directories.browse"; partialPath: string }
  | { id: string; type: "project.add"; path: string; name?: string }
  | { id: string; type: "project.remove"; projectId: string }
  | { id: string; type: "thread.create"; projectId: string; model?: ModelRef }
  | { id: string; type: "thread.delete"; threadId: string }
  | { id: string; type: "thread.setModel"; threadId: string; model: ModelRef }
  | { id: string; type: "thread.subscribe"; threadId: string }
  | { id: string; type: "thread.unsubscribe"; threadId: string }
  | { id: string; type: "turn.start"; threadId: string; text: string; attachments?: TurnAttachment[] }
  | { id: string; type: "turn.interrupt"; threadId: string }
  | { id: string; type: "settings.get" }
  | { id: string; type: "settings.update"; settings: AppSettings }
  | { id: string; type: "skills.list" }
  | { id: string; type: "skill.save"; name: string; description: string; content: string }
  | { id: string; type: "skill.delete"; name: string }
  | { id: string; type: "models.list" }
  | { id: string; type: "provider.models.discover"; provider: ProviderModelDiscoveryConfig }
  | { id: string; type: "files.search"; projectId: string; query: string }
  | { id: string; type: "project.files"; projectId: string }
  | { id: string; type: "project.file.read"; projectId: string; path: string }
  | { id: string; type: "project.diff"; projectId: string }
  | { id: string; type: "terminal.open"; threadId: string; terminalId: string }
  | { id: string; type: "terminal.write"; terminalId: string; data: string }
  | { id: string; type: "terminal.close"; terminalId: string }
  | { id: string; type: "git.bindings" }
  | { id: string; type: "git.bind"; provider: GitProvider; token: string }
  | { id: string; type: "git.unbind"; provider: GitProvider };

export type ServerMessage =
  | { type: "reply"; id: string; ok: true; data?: unknown }
  | { type: "reply"; id: string; ok: false; error: string }
  | { type: "auth.error"; message: string }
  | { type: "shell"; data: ShellState }
  | { type: "settings"; data: AppSettings }
  | { type: "skills"; data: SkillInfo[] }
  | { type: "terminal.event"; event: TerminalEvent }
  | { type: "thread.event"; threadId: string; event: ThreadEvent };

export const DEFAULT_SETTINGS: AppSettings = {
  providers: [],
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
