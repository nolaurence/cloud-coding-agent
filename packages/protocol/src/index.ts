export type WireApi = "completions" | "responses";
export type ProviderType = "openai" | "azure" | "anthropic";

export interface ModelEntry {
  id: string;
  name?: string;
  reasoningEffort?: boolean;
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
}

export interface Project {
  id: string;
  name: string;
  path: string;
}

export interface ThreadMeta {
  id: string;
  projectId: string;
  title: string;
  model?: ModelRef;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
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
  reasoning?: string;
  streaming?: boolean;
  turnId: string;
  createdAt: number;
}

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
  | { kind: "snapshot"; messages: ChatMessage[]; activities: ToolActivity[]; running: boolean }
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
  | { id: string; type: "project.add"; path: string; name?: string }
  | { id: string; type: "project.remove"; projectId: string }
  | { id: string; type: "thread.create"; projectId: string; model?: ModelRef }
  | { id: string; type: "thread.delete"; threadId: string }
  | { id: string; type: "thread.setModel"; threadId: string; model: ModelRef }
  | { id: string; type: "thread.subscribe"; threadId: string }
  | { id: string; type: "thread.unsubscribe"; threadId: string }
  | { id: string; type: "turn.start"; threadId: string; text: string; attachments?: { path: string; displayName?: string }[] }
  | { id: string; type: "turn.interrupt"; threadId: string }
  | { id: string; type: "settings.get" }
  | { id: string; type: "settings.update"; settings: AppSettings }
  | { id: string; type: "skills.list" }
  | { id: string; type: "skill.save"; name: string; description: string; content: string }
  | { id: string; type: "skill.delete"; name: string }
  | { id: string; type: "models.list" }
  | { id: string; type: "files.search"; projectId: string; query: string };

export type ServerMessage =
  | { type: "reply"; id: string; ok: true; data?: unknown }
  | { type: "reply"; id: string; ok: false; error: string }
  | { type: "shell"; data: ShellState }
  | { type: "settings"; data: AppSettings }
  | { type: "skills"; data: SkillInfo[] }
  | { type: "thread.event"; threadId: string; event: ThreadEvent };

export const DEFAULT_SETTINGS: AppSettings = {
  providers: [],
  mcpServers: [],
  skillDirectories: [],
  disabledSkills: [],
};

export function flattenModels(settings: AppSettings): { ref: ModelRef; label: string }[] {
  const out: { ref: ModelRef; label: string }[] = [];
  for (const p of settings.providers) {
    for (const m of p.models) {
      out.push({ ref: { providerId: p.id, modelId: m.id }, label: `${p.name} / ${m.name ?? m.id}` });
    }
  }
  return out;
}
