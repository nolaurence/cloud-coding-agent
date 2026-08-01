import { create } from "zustand";
import type {
  AdminRegistrationState,
  AdminUser,
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
  ModelEntry,
  ModelOption,
  PluginInstallResult,
  PluginMarketplace,
  Workspace,
  ProviderModelDiscoveryConfig,
  RegistrationPolicy,
  ServerMessage,
  ShellState,
  SkillInfo,
  ThreadEvent,
  ThreadMeta,
  ThreadShareMode,
  ThreadSharePreview,
  ThreadShareSummary,
  ToolActivity,
  TurnAttachment,
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
  threadComposerDraftKey,
  updateComposerDraft,
  type ComposerDrafts,
} from "./composerDrafts";

const TOKEN_KEY = "cca-token";
const SHARE_TOKENS_KEY = "cca-thread-share-tokens";

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
  contextUsage: ContextUsage | null;
  running: boolean;
  loaded: boolean;
  activeTurnId: string | null;
  activeTurnStartedAt: number | null;
  live: { text: string; reasoning: string; turnId: string | null };
  error: string | null;
}

const emptyThread: ThreadState = {
  messages: [],
  activities: [],
  contextUsage: null,
  running: false,
  loaded: false,
  activeTurnId: null,
  activeTurnStartedAt: null,
  live: { text: "", reasoning: "", turnId: null },
  error: null,
};

function inferActiveTurn(
  messages: readonly ChatMessage[],
  activities: readonly ToolActivity[],
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

  if (!turnId) return { turnId: null, startedAt: null };
  const userMessage = messages.find(
    (message) => message.turnId === turnId && message.role === "user",
  );
  const turnActivities = activities.filter((activity) => activity.turnId === turnId);
  const firstActivityAt = turnActivities.reduce<number | null>(
    (earliest, activity) =>
      earliest === null ? activity.startedAt : Math.min(earliest, activity.startedAt),
    null,
  );
  return {
    turnId,
    startedAt: userMessage?.createdAt ?? firstActivityAt,
  };
}

interface AppState {
  user: AuthUser | null;
  authReady: boolean;
  connected: boolean;
  projects: Workspace[];
  threads: ThreadMeta[];
  runningThreadIds: string[];
  settings: AppSettings | null;
  connectorStatuses: ConnectorStatus[];
  skills: SkillInfo[];
  models: ModelOption[];
  threadStates: Record<string, ThreadState>;
  composerDrafts: ComposerDrafts;
  activeThreadId: string | null;
  workspacePanelOpen: boolean;
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
  createWorkspace: (name: string) => Promise<Workspace>;
  removeWorkspace: (projectId: string) => Promise<void>;
  createThread: (projectId: string, model?: ModelRef) => Promise<ThreadMeta>;
  deleteThread: (threadId: string) => Promise<void>;
  setThreadModel: (threadId: string, model: ModelRef) => Promise<void>;
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
  saveSkill: (name: string, description: string, content: string) => Promise<void>;
  deleteSkill: (name: string) => Promise<void>;
  listPluginMarketplaces: () => Promise<PluginMarketplace[]>;
  addPluginMarketplace: (source: string) => Promise<{ name: string }>;
  removePluginMarketplace: (
    name: string,
    force?: boolean,
  ) => Promise<{ removed: boolean; dependentPlugins: string[] }>;
  browsePluginMarketplace: (name: string) => Promise<MarketplacePlugin[]>;
  listInstalledPlugins: () => Promise<InstalledPlugin[]>;
  installPlugin: (source: string) => Promise<PluginInstallResult>;
  uninstallPlugin: (name: string, directSourceId?: string) => Promise<void>;
  setPluginEnabled: (name: string, enabled: boolean) => Promise<void>;
  searchFiles: (projectId: string, query: string) => Promise<string[]>;
  setComposerDraft: (key: string, text: string) => void;
  clearComposerDraft: (key: string, expectedText: string) => void;
  setWorkspacePanelOpen: (open: boolean) => void;
  setShareDialogOpen: (open: boolean) => void;
}

function applyThreadEvent(state: ThreadState, event: ThreadEvent): ThreadState {
  switch (event.kind) {
    case "snapshot": {
      const activeTurn = event.running
        ? event.live
          ? { turnId: event.live.turnId, startedAt: event.live.startedAt }
          : inferActiveTurn(event.messages, event.activities)
        : { turnId: null, startedAt: null };
      return {
        ...state,
        messages: event.messages,
        activities: event.activities,
        contextUsage: event.contextUsage ?? null,
        running: event.running,
        loaded: true,
        activeTurnId: activeTurn.turnId,
        activeTurnStartedAt: activeTurn.startedAt,
        live: event.live
          ? { text: event.live.text, reasoning: event.live.reasoning, turnId: event.live.turnId }
          : { text: "", reasoning: "", turnId: null },
        error: null,
      };
    }
    case "turn.start":
      return {
        ...state,
        running: true,
        activeTurnId: event.turnId,
        activeTurnStartedAt: state.running
          ? (state.activeTurnStartedAt ?? Date.now())
          : Date.now(),
        live: { text: "", reasoning: "", turnId: event.turnId },
        error: null,
      };
    case "turn.end": {
      return {
        ...state,
        running: false,
        activeTurnId: null,
        activeTurnStartedAt: null,
        live: { text: "", reasoning: "", turnId: null },
      };
    }
    case "user.message":
      return {
        ...state,
        activeTurnId: state.running ? event.message.turnId : state.activeTurnId,
        activeTurnStartedAt:
          state.running && event.message.role === "user"
            ? event.message.createdAt
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
      const exists = state.messages.some((m) => m.id === event.message.id);
      return {
        ...state,
        messages: exists
          ? state.messages.map((m) => (m.id === event.message.id ? event.message : m))
          : [...state.messages, event.message],
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
    case "context.usage":
      return {
        ...state,
        contextUsage: event.usage ?? null,
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
      models: [],
      threadStates: {},
      composerDrafts: {},
      activeThreadId: null,
      workspacePanelOpen: false,
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
    authReady: false,
    connected: false,
    projects: [],
    threads: [],
    runningThreadIds: [],
    settings: null,
    connectorStatuses: [],
    skills: [],
    models: [],
    threadStates: {},
    composerDrafts: {},
    activeThreadId: null,
    workspacePanelOpen: false,
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
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) {
        set({ authReady: true });
        return;
      }
      apiFetch<{ user: AuthUser }>("/api/auth/me", { auth: true })
        .then((data) => {
          set({ user: data.user, authReady: true });
          connect(token);
        })
        .catch(() => {
          localStorage.removeItem(TOKEN_KEY);
          set({ authReady: true });
        });
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

    createWorkspace: async (name) => {
      return request<Workspace>({ type: "workspace.create", name });
    },

    removeWorkspace: async (projectId) => {
      await request({ type: "workspace.remove", projectId });
    },

    createThread: async (projectId, model) => {
      return request<ThreadMeta>({ type: "thread.create", projectId, model });
    },

    deleteThread: async (threadId) => {
      await request({ type: "thread.delete", threadId });
      set((s) => {
        const threadStates = { ...s.threadStates };
        delete threadStates[threadId];
        return {
          threadStates,
          composerDrafts: updateComposerDraft(
            s.composerDrafts,
            threadComposerDraftKey(threadId),
            "",
          ),
        };
      });
    },

    setThreadModel: async (threadId, model) => {
      await request({ type: "thread.setModel", threadId, model });
      set((s) => ({
        threads: s.threads.map((t) => (t.id === threadId ? { ...t, model } : t)),
      }));
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

    saveSkill: async (name, description, content) => {
      await request({ type: "skill.save", name, description, content });
    },

    deleteSkill: async (name) => {
      await request({ type: "skill.delete", name });
    },

    listPluginMarketplaces: async () => {
      return request<PluginMarketplace[]>({ type: "plugins.marketplaces.list" });
    },

    addPluginMarketplace: async (source) => {
      // 首次克隆市场仓库可能较慢
      return request<{ name: string }>({ type: "plugins.marketplace.add", source }, 180_000);
    },

    removePluginMarketplace: async (name, force) => {
      return request<{ removed: boolean; dependentPlugins: string[] }>({
        type: "plugins.marketplace.remove",
        name,
        force,
      });
    },

    browsePluginMarketplace: async (name) => {
      // 首次克隆市场仓库可能较慢
      return request<MarketplacePlugin[]>({ type: "plugins.marketplace.browse", name }, 180_000);
    },

    listInstalledPlugins: async () => {
      return request<InstalledPlugin[]>({ type: "plugins.list" });
    },

    installPlugin: async (source) => {
      // 安装需要下载插件文件
      return request<PluginInstallResult>({ type: "plugins.install", source }, 180_000);
    },

    uninstallPlugin: async (name, directSourceId) => {
      await request({ type: "plugins.uninstall", name, directSourceId });
    },

    setPluginEnabled: async (name, enabled) => {
      await request({ type: "plugins.setEnabled", name, enabled });
    },

    searchFiles: async (projectId, query) => {
      return request<string[]>({ type: "files.search", projectId, query });
    },
  };
});

export function useThreadState(threadId: string | undefined): ThreadState {
  return useApp((s) => (threadId ? (s.threadStates[threadId] ?? emptyThread) : emptyThread));
}
