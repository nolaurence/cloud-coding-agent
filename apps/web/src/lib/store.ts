import { create } from "zustand";
import type {
  AdminRegistrationState,
  AdminUser,
  AgentMode,
  AgentRuntime,
  AppSettings,
  AuthUser,
  ChatMessage,
  CreatedInvite,
  CreatedThreadShare,
  ConnectorStatus,
  ContextCompactionResult,
  ContextUsage,
  InstalledPlugin,
  MarketplacePlugin,
  ModelRef,
  McpServerConfig,
  ModelEntry,
  ModelOption,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  PluginInstallResult,
  PluginMarketplace,
  Workspace,
  ProviderModelDiscoveryConfig,
  RegistrationPolicy,
  RuntimeStats,
  ServerMessage,
  ShellState,
  SkillInfo,
  SubagentActivity,
  ThreadCreateResult,
  ThreadEvent,
  ThreadMeta,
  ThreadOverviewAnnotations,
  ThreadShareMode,
  ThreadSharePreview,
  ThreadShareSummary,
  ToolActivity,
  TurnAttachment,
  TurnInput,
} from "@cca/protocol";
import {
  connect,
  disconnect,
  onAuthFail,
  onConnectionChange,
  onEvent,
  onReconnect,
  request,
} from "./client";
import {
  clearComposerDraft,
  updateComposerDraft,
  type ComposerDrafts,
} from "./composerDrafts";

const TOKEN_KEY = "cca-token";
const SHARE_TOKENS_KEY = "cca-thread-share-tokens";
const PANEL_PLACEMENT_KEY = "cloud-coding-agent:panel-placement";

function readPanelPlacement(): "left" | "right" {
  try {
    return window.localStorage.getItem(PANEL_PLACEMENT_KEY) === "left" ? "left" : "right";
  } catch {
    return "right";
  }
}

async function apiFetch<T>(
  path: string,
  options: { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown; auth?: boolean } = {},
): Promise<T> {
  const token = options.auth ? localStorage.getItem(TOKEN_KEY) : null;
  if (options.auth && !token) throw new Error("未登录");
  const res = await fetch(path, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `请求失败 (${res.status})`);
  return data as T;
}

function loadShareTokens(username: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(SHARE_TOKENS_KEY) ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const tokens = (value as Record<string, unknown>)[username];
    return Array.isArray(tokens)
      ? tokens.filter((token): token is string => typeof token === "string")
      : [];
  } catch {
    return [];
  }
}

function saveShareTokens(username: string, tokens: readonly string[]) {
  try {
    const existing = JSON.parse(localStorage.getItem(SHARE_TOKENS_KEY) ?? "{}") as unknown;
    const byUser = existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing as Record<string, unknown>
      : {};
    localStorage.setItem(
      SHARE_TOKENS_KEY,
      JSON.stringify({ ...byUser, [username]: [...new Set(tokens)] }),
    );
  } catch {
    try {
      localStorage.setItem(SHARE_TOKENS_KEY, JSON.stringify({ [username]: [...new Set(tokens)] }));
    } catch {
      // Sharing still works when browser storage is unavailable; only reconnect restore is skipped.
    }
  }
}

function rememberShareToken(username: string, token: string) {
  saveShareTokens(username, [...loadShareTokens(username), token]);
}

interface ThreadState {
  messages: ChatMessage[];
  activities: ToolActivity[];
  subagents: SubagentActivity[];
  contextUsage: ContextUsage | null;
  runtimeStats: RuntimeStats | null;
  running: boolean;
  loaded: boolean;
  activeTurnId: string | null;
  activeTurnStartedAt: number | null;
  live: { text: string; reasoning: string; turnId: string | null };
  pendingPermission: PermissionRequest | null;
  error: string | null;
}

const emptyThread: ThreadState = {
  messages: [],
  activities: [],
  subagents: [],
  contextUsage: null,
  runtimeStats: null,
  running: false,
  loaded: false,
  activeTurnId: null,
  activeTurnStartedAt: null,
  live: { text: "", reasoning: "", turnId: null },
  pendingPermission: null,
  error: null,
};

function inferActiveTurn(
  messages: readonly ChatMessage[],
  activities: readonly ToolActivity[],
  subagents: readonly SubagentActivity[],
): { turnId: string | null; startedAt: number | null } {
  let turnId: string | null = null;
  let latestAt = -1;

  for (const message of messages) {
    if (message.turnId && message.createdAt >= latestAt) {
      turnId = message.turnId;
      latestAt = message.createdAt;
    }
  }
  for (const activity of activities) {
    if (activity.turnId && activity.startedAt >= latestAt) {
      turnId = activity.turnId;
      latestAt = activity.startedAt;
    }
  }
  for (const subagent of subagents) {
    if (subagent.turnId && subagent.startedAt >= latestAt) {
      turnId = subagent.turnId;
      latestAt = subagent.startedAt;
    }
  }

  if (!turnId) return { turnId: null, startedAt: null };
  const userMessage = messages.find(
    (message) => message.turnId === turnId && message.role === "user",
  );
  const turnActivities = activities.filter((activity) => activity.turnId === turnId);
  const turnSubagents = subagents.filter((subagent) => subagent.turnId === turnId);
  const firstActivityAt = turnActivities.reduce<number | null>(
    (earliest, activity) =>
      earliest === null ? activity.startedAt : Math.min(earliest, activity.startedAt),
    null,
  );
  const firstSubagentAt = turnSubagents.reduce<number | null>(
    (earliest, subagent) =>
      earliest === null ? subagent.startedAt : Math.min(earliest, subagent.startedAt),
    null,
  );
  const firstWorkAt = firstActivityAt === null
    ? firstSubagentAt
    : firstSubagentAt === null
      ? firstActivityAt
      : Math.min(firstActivityAt, firstSubagentAt);
  return {
    turnId,
    startedAt: userMessage?.createdAt ?? firstWorkAt,
  };
}

interface AppState {
  user: AuthUser | null;
  localMode: boolean;
  authReady: boolean;
  connected: boolean;
  projects: Workspace[];
  threads: ThreadMeta[];
  runningThreadIds: string[];
  settings: AppSettings | null;
  connectorStatuses: ConnectorStatus[];
  skills: SkillInfo[];
  plugins: InstalledPlugin[];
  pluginMarketplaces: PluginMarketplace[];
  pluginCatalog: MarketplacePlugin[];
  pluginBusy: boolean;
  models: ModelOption[];
  threadStates: Record<string, ThreadState>;
  composerDrafts: ComposerDrafts;
  activeThreadId: string | null;
  workspacePanelOpen: boolean;
  panelPlacement: "left" | "right";
  shareDialogOpen: boolean;

  init: () => void;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string, inviteCode?: string) => Promise<void>;
  logout: () => void;
  getRegistrationPolicy: () => Promise<RegistrationPolicy>;
  getAdminUsers: () => Promise<AdminUser[]>;
  setUserRole: (username: string, role: AdminUser["role"]) => Promise<AdminUser>;
  getAdminRegistration: () => Promise<AdminRegistrationState>;
  setInviteRequired: (inviteRequired: boolean) => Promise<AdminRegistrationState>;
  createInvite: () => Promise<CreatedInvite>;
  revokeInvite: (inviteId: string) => Promise<void>;
  refreshModels: () => Promise<void>;
  discoverProviderModels: (provider: ProviderModelDiscoveryConfig) => Promise<ModelEntry[]>;
  createWorkspace: (name: string, path?: string) => Promise<Workspace>;
  selectLocalFolder: () => Promise<string | null>;
  removeWorkspace: (projectId: string) => Promise<void>;
  createThread: (
    projectId: string,
    model?: ModelRef,
    agentMode?: AgentMode,
    permissionMode?: PermissionMode,
    initialTurn?: TurnInput,
    runtime?: AgentRuntime,
  ) => Promise<ThreadMeta>;
  setThreadPinned: (threadId: string, pinned: boolean) => Promise<ThreadMeta>;
  setThreadArchived: (threadId: string, archived: boolean) => Promise<ThreadMeta>;
  setThreadModel: (threadId: string, model: ModelRef) => Promise<void>;
  updateThreadOverview: (threadId: string, overview: ThreadOverviewAnnotations) => Promise<void>;
  setThreadAgentMode: (threadId: string, agentMode: AgentMode) => Promise<void>;
  setThreadPermissionMode: (
    threadId: string,
    permissionMode: PermissionMode,
  ) => Promise<void>;
  respondPermission: (
    threadId: string,
    requestId: string,
    decision: PermissionDecision,
  ) => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  closeThread: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, text: string, attachments?: TurnAttachment[]) => Promise<void>;
  interrupt: (threadId: string) => Promise<void>;
  compactContext: (threadId: string) => Promise<ContextCompactionResult>;
  getThreadShare: (threadId: string) => Promise<ThreadShareSummary>;
  createThreadShare: (threadId: string, mode: ThreadShareMode) => Promise<CreatedThreadShare>;
  revokeThreadShare: (threadId: string) => Promise<void>;
  previewThreadShare: (token: string) => Promise<ThreadSharePreview>;
  redeemThreadShare: (token: string) => Promise<ThreadMeta>;
  updateSettings: (settings: AppSettings) => Promise<void>;
  refreshConnectorStatuses: () => Promise<void>;
  saveMcpServer: (server: McpServerConfig) => Promise<void>;
  deleteMcpServer: (id: string) => Promise<void>;
  saveSkill: (name: string, description: string, content: string) => Promise<void>;
  deleteSkill: (name: string) => Promise<void>;
  loadPlugins: () => Promise<void>;
  installPlugin: (source: string, subdirectory?: string) => Promise<PluginInstallResult>;
  uninstallPlugin: (name: string) => Promise<void>;
  setPluginEnabled: (name: string, enabled: boolean) => Promise<void>;
  addPluginMarketplace: (source: string) => Promise<PluginMarketplace>;
  removePluginMarketplace: (marketplaceId: string) => Promise<void>;
  searchFiles: (projectId: string, query: string) => Promise<string[]>;
  setComposerDraft: (key: string, text: string) => void;
  clearComposerDraft: (key: string, expectedText: string) => void;
  setWorkspacePanelOpen: (open: boolean) => void;
  setPanelPlacement: (placement: "left" | "right") => void;
  setShareDialogOpen: (open: boolean) => void;
}

export function applyThreadEvent(state: ThreadState, event: ThreadEvent): ThreadState {
  switch (event.kind) {
    case "snapshot": {
      const inferred = event.running && !event.activeTurn
        ? inferActiveTurn(event.messages, event.activities, event.subagents ?? [])
        : { turnId: null, startedAt: null };
      const turnId = event.activeTurn?.turnId ?? event.live?.turnId ?? inferred.turnId;
      const previousStartedAt = state.running && state.activeTurnId === turnId
        ? state.activeTurnStartedAt
        : null;
      const activeTurn = event.running
        ? {
            turnId,
            startedAt: event.activeTurn?.startedAt ?? previousStartedAt ??
              (inferred.turnId === turnId ? inferred.startedAt : null) ??
              event.live?.startedAt ?? null,
          }
        : { turnId: null, startedAt: null };
      return {
        ...state,
        messages: event.messages,
        activities: event.activities,
        subagents: event.subagents ?? [],
        contextUsage: event.contextUsage ?? null,
        runtimeStats: event.runtimeStats ?? null,
        running: event.running,
        loaded: true,
        activeTurnId: activeTurn.turnId,
        activeTurnStartedAt: activeTurn.startedAt,
        live: event.live
          ? { text: event.live.text, reasoning: event.live.reasoning, turnId: event.live.turnId }
          : { text: "", reasoning: "", turnId: null },
        pendingPermission: event.pendingPermission ?? null,
        error: event.error ?? null,
      };
    }
    case "turn.start":
      return {
        ...state,
        running: true,
        activeTurnId: event.turnId,
        activeTurnStartedAt: event.startedAt ??
          (state.running ? state.activeTurnStartedAt : null) ?? Date.now(),
        live: { text: "", reasoning: "", turnId: event.turnId },
        pendingPermission: null,
        error: null,
      };
    case "turn.end": {
      return {
        ...state,
        running: false,
        activeTurnId: null,
        activeTurnStartedAt: null,
        live: { text: "", reasoning: "", turnId: null },
        pendingPermission: null,
      };
    }
    case "user.message":
      return {
        ...state,
        activeTurnId: state.running ? event.message.turnId : state.activeTurnId,
        activeTurnStartedAt:
          state.running && event.message.role === "user"
            ? (state.activeTurnStartedAt ?? event.message.createdAt)
            : state.activeTurnStartedAt,
        messages: state.messages.some((message) => message.id === event.message.id)
          ? state.messages.map((message) =>
              message.id === event.message.id ? event.message : message,
            )
          : [...state.messages, event.message],
      };
    case "assistant.delta":
      return {
        ...state,
        activeTurnId: event.turnId || state.activeTurnId,
        live: {
          ...state.live,
          text: state.live.text + event.delta,
          turnId: event.turnId || state.live.turnId || state.activeTurnId,
        },
      };
    case "assistant.reasoning_delta":
      return {
        ...state,
        activeTurnId: event.turnId || state.activeTurnId,
        live: {
          ...state.live,
          reasoning: state.live.reasoning + event.delta,
          turnId: event.turnId || state.live.turnId || state.activeTurnId,
        },
      };
    case "assistant.message": {
      const liveReasoning =
        !event.message.reasoning &&
        (!state.live.turnId || state.live.turnId === event.message.turnId)
          ? state.live.reasoning
          : "";
      const message = liveReasoning
        ? { ...event.message, reasoning: liveReasoning }
        : event.message;
      const exists = state.messages.some((m) => m.id === message.id);
      return {
        ...state,
        messages: exists
          ? state.messages.map((m) => (m.id === message.id ? message : m))
          : [...state.messages, message],
        live: { text: "", reasoning: "", turnId: null },
      };
    }
    case "tool.start":
      return {
        ...state,
        activeTurnId: event.activity.turnId || state.activeTurnId,
        activeTurnStartedAt: state.activeTurnStartedAt ?? event.activity.startedAt,
        activities: [
          ...state.activities.filter((activity) => activity.id !== event.activity.id),
          event.activity,
        ],
      };
    case "tool.complete":
      return {
        ...state,
        activities: state.activities.some((a) => a.id === event.activity.id)
          ? state.activities.map((a) => (a.id === event.activity.id ? event.activity : a))
          : [...state.activities, event.activity],
      };
    case "subagent.update":
      return {
        ...state,
        activeTurnId: state.running
          ? event.subagent.turnId || state.activeTurnId
          : state.activeTurnId,
        activeTurnStartedAt:
          state.running && state.activeTurnStartedAt === null
            ? event.subagent.startedAt
            : state.activeTurnStartedAt,
        subagents: state.subagents.some((subagent) => subagent.id === event.subagent.id)
          ? state.subagents.map((subagent) =>
              subagent.id === event.subagent.id ? event.subagent : subagent,
            )
          : [...state.subagents, event.subagent],
      };
    case "subagent.message_delta": {
      const existing = state.subagents.find(
        (subagent) => subagent.id === event.subagentId,
      );
      const placeholder: SubagentActivity = existing ?? {
        id: event.subagentId,
        turnId: state.activeTurnId ?? "",
        toolCallId: event.subagentId,
        agentName: "subagent",
        agentDisplayName: "子代理",
        agentDescription: "正在执行委派任务",
        status: "running",
        messages: [],
        activities: [],
        startedAt: event.startedAt,
      };
      const previousLive = placeholder.live;
      const switchedMessage = Boolean(
        previousLive?.messageId && previousLive.messageId !== event.messageId,
      );
      const messages = switchedMessage && previousLive && (previousLive.text || previousLive.reasoning)
        ? [
            ...placeholder.messages,
            {
              id: previousLive.messageId!,
              role: "assistant" as const,
              text: previousLive.text,
              reasoning: previousLive.reasoning || undefined,
              createdAt: previousLive.startedAt,
            },
          ]
        : placeholder.messages;
      const live = switchedMessage || !previousLive
        ? {
            messageId: event.messageId,
            text: event.delta,
            reasoning: "",
            startedAt: event.startedAt,
          }
        : {
            ...previousLive,
            messageId: previousLive.messageId ?? event.messageId,
            text: previousLive.text + event.delta,
          };
      const next = { ...placeholder, messages, live };
      return {
        ...state,
        subagents: existing
          ? state.subagents.map((subagent) =>
              subagent.id === event.subagentId ? next : subagent,
            )
          : [...state.subagents, next],
      };
    }
    case "subagent.reasoning_delta": {
      const existing = state.subagents.find(
        (subagent) => subagent.id === event.subagentId,
      );
      const placeholder: SubagentActivity = existing ?? {
        id: event.subagentId,
        turnId: state.activeTurnId ?? "",
        toolCallId: event.subagentId,
        agentName: "subagent",
        agentDisplayName: "子代理",
        agentDescription: "正在执行委派任务",
        status: "running",
        messages: [],
        activities: [],
        startedAt: event.startedAt,
      };
      const next = {
        ...placeholder,
        live: {
          ...placeholder.live,
          text: placeholder.live?.text ?? "",
          reasoning: (placeholder.live?.reasoning ?? "") + event.delta,
          startedAt: placeholder.live?.startedAt ?? event.startedAt,
        },
      };
      return {
        ...state,
        subagents: existing
          ? state.subagents.map((subagent) =>
              subagent.id === event.subagentId ? next : subagent,
            )
          : [...state.subagents, next],
      };
    }
    case "permission.request":
      return {
        ...state,
        pendingPermission: event.request,
      };
    case "permission.resolve":
      return {
        ...state,
        pendingPermission:
          state.pendingPermission?.requestId === event.requestId
            ? null
            : state.pendingPermission,
      };
    case "context.usage":
      return {
        ...state,
        contextUsage: event.usage ?? null,
      };
    case "runtime.stats":
      return {
        ...state,
        runtimeStats: event.stats ?? null,
      };
    case "error":
      return {
        ...state,
        running: false,
        activeTurnId: null,
        activeTurnStartedAt: null,
        live: state.live,
        error: event.message,
      };
    default:
      return state;
  }
}

export const useApp = create<AppState>((set, get) => {
  function handleServerMessage(msg: ServerMessage) {
    if (msg.type === "shell") {
      const data = msg.data as ShellState;
      set((state) => {
        const runningIds = new Set(data.runningThreadIds);
        const threadStates = Object.fromEntries(
          Object.entries(state.threadStates).map(([threadId, threadState]) => [
            threadId,
            runningIds.has(threadId)
              ? { ...threadState, running: true }
              : {
                  ...threadState,
                  running: false,
                  activeTurnId: null,
                  activeTurnStartedAt: null,
                  live: { text: "", reasoning: "", turnId: null },
                },
          ]),
        );
        return {
          projects: data.projects,
          threads: data.threads,
          runningThreadIds: data.runningThreadIds,
          threadStates,
        };
      });
    } else if (msg.type === "settings") {
      set({ settings: msg.data });
      void get().refreshModels();
    } else if (msg.type === "connectors.status") {
      set({ connectorStatuses: msg.data });
    } else if (msg.type === "skills") {
      set({ skills: msg.data });
    } else if (msg.type === "auth.user") {
      set({ user: msg.user });
    } else if (msg.type === "thread.event") {
      set((s) => {
        const prev = s.threadStates[msg.threadId] ?? emptyThread;
        const next = applyThreadEvent(prev, msg.event);
        const threadStates = { ...s.threadStates, [msg.threadId]: next };
        const runningThreadIds = next.running
          ? [...new Set([...s.runningThreadIds, msg.threadId])]
          : s.runningThreadIds.filter((id) => id !== msg.threadId);
        return { threadStates, runningThreadIds };
      });
    }
  }

  let initialized = false;

  function resetSessionState() {
    set({
      connected: false,
      projects: [],
      threads: [],
      runningThreadIds: [],
      settings: null,
      connectorStatuses: [],
      skills: [],
      plugins: [],
      pluginMarketplaces: [],
      pluginCatalog: [],
      pluginBusy: false,
      models: [],
      threadStates: {},
      composerDrafts: {},
      activeThreadId: null,
      workspacePanelOpen: false,
      panelPlacement: "right",
      shareDialogOpen: false,
    });
  }

  function startSession(token: string, user: AuthUser) {
    localStorage.setItem(TOKEN_KEY, token);
    set({ user, authReady: true });
    connect(token);
  }

  return {
    user: null,
    localMode: false,
    authReady: false,
    connected: false,
    projects: [],
    threads: [],
    runningThreadIds: [],
    settings: null,
    connectorStatuses: [],
    skills: [],
    plugins: [],
    pluginMarketplaces: [],
    pluginCatalog: [],
    pluginBusy: false,
    models: [],
    threadStates: {},
    composerDrafts: {},
    activeThreadId: null,
    workspacePanelOpen: false,
    panelPlacement: readPanelPlacement(),
    shareDialogOpen: false,

    init: () => {
      if (initialized) return;
      initialized = true;
      onEvent(handleServerMessage);
      onAuthFail(() => {
        get().logout();
      });
      onConnectionChange((connected) => set({ connected }));
      onReconnect(() => {
        void (async () => {
          const username = get().user?.username;
          if (!username) return;
          const validTokens: string[] = [];
          for (const shareToken of loadShareTokens(username)) {
            try {
              await request<ThreadMeta>({ type: "thread.share.redeem", token: shareToken });
              validTokens.push(shareToken);
            } catch {
              // Invalid and revoked links should not be retried on every reconnect.
            }
          }
          saveShareTokens(username, validTokens);
          await request({ type: "shell.subscribe" }).catch(() => {});
          const active = get().activeThreadId;
          if (active) await get().openThread(active).catch(() => {});
        })();
      });
      void (async () => {
        try {
          const runtime = await fetch("/api/runtime").then((response) => response.json()) as { localMode?: boolean };
          if (runtime.localMode) {
            set({ localMode: true });
            startSession("cca-local-mode", { username: "local", role: "admin" });
            return;
          }
        } catch {
          // Older remote servers do not expose the runtime endpoint.
        }
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token) {
          set({ authReady: true });
          return;
        }
        try {
          const data = await apiFetch<{ user: AuthUser }>("/api/auth/me", { auth: true });
          set({ user: data.user, authReady: true });
          connect(token);
        } catch {
          localStorage.removeItem(TOKEN_KEY);
          set({ authReady: true });
        }
      })();
    },

    login: async (username, password) => {
      const data = await apiFetch<{ token: string; user: AuthUser }>("/api/auth/login", {
        body: { username, password },
      });
      startSession(data.token!, data.user);
    },

    register: async (username, password, inviteCode) => {
      const data = await apiFetch<{ token: string; user: AuthUser }>("/api/auth/register", {
        body: { username, password, inviteCode },
      });
      startSession(data.token!, data.user);
    },

    logout: () => {
      localStorage.removeItem(TOKEN_KEY);
      disconnect();
      resetSessionState();
      set({ user: null });
    },

    setWorkspacePanelOpen: (open) => set({ workspacePanelOpen: open }),
    setPanelPlacement: (placement) => {
      try {
        window.localStorage.setItem(PANEL_PLACEMENT_KEY, placement);
      } catch {
        // Layout preference is optional when storage is unavailable.
      }
      set({ panelPlacement: placement });
    },
    setShareDialogOpen: (open) => set({ shareDialogOpen: open }),
    setComposerDraft: (key, text) =>
      set((state) => ({
        composerDrafts: updateComposerDraft(state.composerDrafts, key, text),
      })),
    clearComposerDraft: (key, expectedText) =>
      set((state) => ({
        composerDrafts: clearComposerDraft(state.composerDrafts, key, expectedText),
      })),

    getRegistrationPolicy: () => apiFetch<RegistrationPolicy>("/api/auth/registration"),

    getAdminUsers: () => apiFetch<AdminUser[]>("/api/admin/users", { auth: true }),

    setUserRole: (username, role) =>
      apiFetch<AdminUser>(`/api/admin/users/${encodeURIComponent(username)}/role`, {
        method: "PATCH",
        body: { role },
        auth: true,
      }),

    getAdminRegistration: () =>
      apiFetch<AdminRegistrationState>("/api/admin/registration", { auth: true }),

    setInviteRequired: (inviteRequired) =>
      apiFetch<AdminRegistrationState>("/api/admin/registration", {
        method: "PUT",
        body: { inviteRequired },
        auth: true,
      }),

    createInvite: () =>
      apiFetch<CreatedInvite>("/api/admin/invites", { method: "POST", auth: true }),

    revokeInvite: async (inviteId) => {
      await apiFetch(`/api/admin/invites/${encodeURIComponent(inviteId)}`, {
        method: "DELETE",
        auth: true,
      });
    },

    refreshModels: async () => {
      try {
        const models = await request<ModelOption[]>({ type: "models.list" });
        set({ models });
      } catch {
        // ignore
      }
    },

    discoverProviderModels: async (provider) => {
      return request<ModelEntry[]>({ type: "provider.models.discover", provider });
    },

    createWorkspace: async (name, path) => {
      return request<Workspace>({ type: "workspace.create", name, path });
    },

    selectLocalFolder: async () => {
      if (!window.ccaDesktop?.selectFolder) {
        throw new Error("当前窗口未启用本地文件夹选择器");
      }
      return window.ccaDesktop.selectFolder();
    },

    removeWorkspace: async (projectId) => {
      await request({ type: "workspace.remove", projectId });
    },

    createThread: async (projectId, model, agentMode, permissionMode, initialTurn, runtime) => {
      const created = await request<ThreadCreateResult>({
        type: "thread.create",
        projectId,
        model,
        agentMode,
        permissionMode,
        runtime,
        initialTurn,
      });
      const { initialTurnAccepted, ...thread } = created;
      if (initialTurn && initialTurnAccepted !== true) {
        try {
          await request({
            type: "turn.start",
            threadId: thread.id,
            text: initialTurn.text,
            attachments: initialTurn.attachments,
          });
        } catch (error) {
          try {
            await request({ type: "thread.delete", threadId: thread.id });
          } catch (cleanupError) {
            const originalMessage = error instanceof Error ? error.message : String(error);
            const cleanupMessage =
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
            throw new Error(`${originalMessage} (清理新会话失败: ${cleanupMessage})`, {
              cause: error,
            });
          }
          throw error;
        }
      }
      set((state) => ({
        threads: state.threads.some((candidate) => candidate.id === thread.id)
          ? state.threads
          : [thread, ...state.threads],
      }));
      return thread;
    },

    setThreadPinned: async (threadId, pinned) => {
      const updated = await request<ThreadMeta>({
        type: "thread.setPinned",
        threadId,
        pinned,
      });
      set((state) => ({
        threads: state.threads.map((thread) => (thread.id === threadId ? updated : thread)),
      }));
      return updated;
    },

    setThreadArchived: async (threadId, archived) => {
      const updated = await request<ThreadMeta>({
        type: "thread.setArchived",
        threadId,
        archived,
      });
      set((state) => ({
        threads: state.threads.map((thread) => (thread.id === threadId ? updated : thread)),
      }));
      return updated;
    },

    setThreadModel: async (threadId, model) => {
      await request({ type: "thread.setModel", threadId, model });
      set((s) => ({
        threads: s.threads.map((t) => (t.id === threadId ? { ...t, model } : t)),
      }));
    },

    updateThreadOverview: async (threadId, overview) => {
      const saved = await request<ThreadOverviewAnnotations>({ type: "thread.overview.update", threadId, overview });
      set((state) => ({ threads: state.threads.map((thread) => thread.id === threadId ? { ...thread, overview: saved } : thread) }));
    },

    setThreadAgentMode: async (threadId, agentMode) => {
      await request({ type: "thread.setAgentMode", threadId, agentMode });
      set((state) => ({
        threads: state.threads.map((thread) =>
          thread.id === threadId ? { ...thread, agentMode } : thread,
        ),
      }));
    },

    setThreadPermissionMode: async (threadId, permissionMode) => {
      await request({ type: "thread.setPermissionMode", threadId, permissionMode });
      set((state) => ({
        threads: state.threads.map((thread) =>
          thread.id === threadId ? { ...thread, permissionMode } : thread,
        ),
      }));
    },

    respondPermission: async (threadId, requestId, decision) => {
      const previous = get().threadStates[threadId]?.pendingPermission ?? null;
      set((state) => ({
        threadStates: state.threadStates[threadId]
          ? {
              ...state.threadStates,
              [threadId]: {
                ...state.threadStates[threadId]!,
                pendingPermission:
                  state.threadStates[threadId]!.pendingPermission?.requestId === requestId
                    ? null
                    : state.threadStates[threadId]!.pendingPermission,
              },
            }
          : state.threadStates,
      }));
      try {
        await request({ type: "permission.respond", threadId, requestId, decision });
      } catch (error) {
        if (previous) {
          set((state) => ({
            threadStates: state.threadStates[threadId]
              ? {
                  ...state.threadStates,
                  [threadId]: {
                    ...state.threadStates[threadId]!,
                    pendingPermission:
                      state.threadStates[threadId]!.pendingPermission === null
                        ? previous
                        : state.threadStates[threadId]!.pendingPermission,
                  },
                }
              : state.threadStates,
          }));
        }
        throw error;
      }
    },

    openThread: async (threadId) => {
      set({ activeThreadId: threadId });
      await request({ type: "thread.subscribe", threadId });
    },

    closeThread: async (threadId) => {
      set((s) => ({ activeThreadId: s.activeThreadId === threadId ? null : s.activeThreadId }));
      await request({ type: "thread.unsubscribe", threadId }).catch(() => {});
    },

    sendMessage: async (threadId, text, attachments) => {
      set((state) => {
        const previous = state.threadStates[threadId] ?? emptyThread;
        return {
          threadStates: {
            ...state.threadStates,
            [threadId]: {
              ...previous,
              running: true,
              activeTurnStartedAt: Date.now(),
              error: null,
            },
          },
          runningThreadIds: [...new Set([...state.runningThreadIds, threadId])],
        };
      });
      try {
        await request({ type: "turn.start", threadId, text, attachments });
      } catch (error) {
        set((state) => {
          const previous = state.threadStates[threadId] ?? emptyThread;
          return {
            threadStates: {
              ...state.threadStates,
              [threadId]: {
                ...previous,
                running: false,
                activeTurnId: null,
                activeTurnStartedAt: null,
                error: error instanceof Error ? error.message : "消息发送失败",
              },
            },
            runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
          };
        });
        throw error;
      }
    },

    compactContext: (threadId) =>
      request<ContextCompactionResult>({ type: "thread.compact", threadId }),

    interrupt: async (threadId) => {
      await request({ type: "turn.interrupt", threadId });
      set((state) => {
        const previous = state.threadStates[threadId] ?? emptyThread;
        return {
          threadStates: {
            ...state.threadStates,
            [threadId]: {
              ...previous,
              running: false,
              activeTurnId: null,
              activeTurnStartedAt: null,
            },
          },
          runningThreadIds: state.runningThreadIds.filter((id) => id !== threadId),
        };
      });
    },

    getThreadShare: (threadId) =>
      request<ThreadShareSummary>({ type: "thread.share.get", threadId }),

    createThreadShare: (threadId, mode) =>
      request<CreatedThreadShare>({ type: "thread.share.create", threadId, mode }),

    revokeThreadShare: async (threadId) => {
      await request({ type: "thread.share.revoke", threadId });
    },

    previewThreadShare: (token) =>
      request<ThreadSharePreview>({ type: "thread.share.preview", token }),

    redeemThreadShare: async (token) => {
      const thread = await request<ThreadMeta>({ type: "thread.share.redeem", token });
      const username = get().user?.username;
      if (username) rememberShareToken(username, token);
      set((state) => ({
        threads: state.threads.some((candidate) => candidate.id === thread.id)
          ? state.threads.map((candidate) => (candidate.id === thread.id ? thread : candidate))
          : [thread, ...state.threads],
      }));
      return thread;
    },

    updateSettings: async (settings) => {
      await request({ type: "settings.update", settings });
    },

    refreshConnectorStatuses: async () => {
      const connectorStatuses = await request<ConnectorStatus[]>({ type: "connectors.status" });
      set({ connectorStatuses });
    },

    saveMcpServer: async (server) => {
      const saved = await request<McpServerConfig>({ type: "mcp.save", server });
      set((state) => state.settings
        ? {
            settings: {
              ...state.settings,
              mcpServers: state.settings.mcpServers.some((item) => item.id === saved.id)
                ? state.settings.mcpServers.map((item) => item.id === saved.id ? saved : item)
                : [...state.settings.mcpServers, saved],
            },
          }
        : {});
    },

    deleteMcpServer: async (id) => {
      await request({ type: "mcp.delete", idToDelete: id });
      set((state) => state.settings
        ? { settings: { ...state.settings, mcpServers: state.settings.mcpServers.filter((item) => item.id !== id) } }
        : {});
    },

    saveSkill: async (name, description, content) => {
      await request({ type: "skill.save", name, description, content });
    },

    deleteSkill: async (name) => {
      await request({ type: "skill.delete", name });
    },

    loadPlugins: async () => {
      const [plugins, marketplaces] = await Promise.all([
        request<InstalledPlugin[]>({ type: "plugins.list" }),
        request<PluginMarketplace[]>({ type: "plugins.marketplaces.list" }),
      ]);
      // 远程市场拉取失败不应影响其它市场与已安装列表
      const catalogs = await Promise.all(marketplaces.map(async (marketplace) => {
        try {
          return await request<MarketplacePlugin[]>(
            { type: "plugins.marketplace.browse", marketplaceId: marketplace.id },
            60_000,
          );
        } catch {
          return [] as MarketplacePlugin[];
        }
      }));
      set({ plugins, pluginMarketplaces: marketplaces, pluginCatalog: catalogs.flat() });
    },

    installPlugin: async (source, subdirectory) => {
      set({ pluginBusy: true });
      try {
        // 安装需要克隆仓库,给足时间
        const result = await request<PluginInstallResult>(
          { type: "plugins.install", source, subdirectory },
          180_000,
        );
        await get().loadPlugins();
        return result;
      } finally {
        set({ pluginBusy: false });
      }
    },

    uninstallPlugin: async (name) => {
      set({ pluginBusy: true });
      try {
        await request({ type: "plugins.uninstall", name });
        await get().loadPlugins();
      } finally {
        set({ pluginBusy: false });
      }
    },

    setPluginEnabled: async (name, enabled) => {
      await request({ type: "plugins.setEnabled", name, enabled });
      await get().loadPlugins();
    },

    addPluginMarketplace: async (source) => {
      const marketplace = await request<PluginMarketplace>(
        { type: "plugins.marketplace.add", source },
        60_000,
      );
      await get().loadPlugins();
      return marketplace;
    },

    removePluginMarketplace: async (marketplaceId) => {
      await request({ type: "plugins.marketplace.remove", marketplaceId });
      await get().loadPlugins();
    },

    searchFiles: async (projectId, query) => {
      return request<string[]>({ type: "files.search", projectId, query });
    },
  };
});

export function useThreadState(threadId: string | undefined): ThreadState {
  return useApp((s) => (threadId ? (s.threadStates[threadId] ?? emptyThread) : emptyThread));
}
