import { create } from "zustand";
import type {
  AppSettings,
  AuthUser,
  ChatMessage,
  DirectoryBrowseResult,
  ModelRef,
  ModelEntry,
  ModelOption,
  Project,
  ProviderModelDiscoveryConfig,
  ServerMessage,
  ShellState,
  SkillInfo,
  ThreadEvent,
  ThreadMeta,
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

const TOKEN_KEY = "cca-token";

async function authFetch(path: string, body: unknown, token?: string) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `请求失败 (${res.status})`);
  return data as { token?: string; user: AuthUser };
}

interface ThreadState {
  messages: ChatMessage[];
  activities: ToolActivity[];
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
  projects: Project[];
  threads: ThreadMeta[];
  runningThreadIds: string[];
  settings: AppSettings | null;
  skills: SkillInfo[];
  models: ModelOption[];
  threadStates: Record<string, ThreadState>;
  activeThreadId: string | null;

  init: () => void;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => void;
  refreshModels: () => Promise<void>;
  discoverProviderModels: (provider: ProviderModelDiscoveryConfig) => Promise<ModelEntry[]>;
  browseDirectories: (partialPath: string) => Promise<DirectoryBrowseResult>;
  addProject: (path: string, name?: string) => Promise<Project>;
  removeProject: (projectId: string) => Promise<void>;
  createThread: (projectId: string, model?: ModelRef) => Promise<ThreadMeta>;
  deleteThread: (threadId: string) => Promise<void>;
  setThreadModel: (threadId: string, model: ModelRef) => Promise<void>;
  openThread: (threadId: string) => Promise<void>;
  closeThread: (threadId: string) => Promise<void>;
  sendMessage: (threadId: string, text: string, attachments?: TurnAttachment[]) => Promise<void>;
  interrupt: (threadId: string) => Promise<void>;
  updateSettings: (settings: AppSettings) => Promise<void>;
  saveSkill: (name: string, description: string, content: string) => Promise<void>;
  deleteSkill: (name: string) => Promise<void>;
  searchFiles: (projectId: string, query: string) => Promise<string[]>;
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
    } else if (msg.type === "skills") {
      set({ skills: msg.data });
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
      skills: [],
      models: [],
      threadStates: {},
      activeThreadId: null,
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
    skills: [],
    models: [],
    threadStates: {},
    activeThreadId: null,

    init: () => {
      if (initialized) return;
      initialized = true;
      onEvent(handleServerMessage);
      onAuthFail(() => {
        get().logout();
      });
      onConnectionChange((connected) => set({ connected }));
      onReconnect(() => {
        void request({ type: "shell.subscribe" }).catch(() => {});
        const active = get().activeThreadId;
        if (active) {
          void get().openThread(active);
        }
      });
      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) {
        set({ authReady: true });
        return;
      }
      authFetch("/api/auth/me", null, token)
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
      const data = await authFetch("/api/auth/login", { username, password });
      startSession(data.token!, data.user);
    },

    register: async (username, password) => {
      const data = await authFetch("/api/auth/register", { username, password });
      startSession(data.token!, data.user);
    },

    logout: () => {
      localStorage.removeItem(TOKEN_KEY);
      disconnect();
      resetSessionState();
      set({ user: null });
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

    browseDirectories: async (partialPath) => {
      return request<DirectoryBrowseResult>({ type: "directories.browse", partialPath });
    },

    addProject: async (path, name) => {
      const project = await request<Project>({ type: "project.add", path, name });
      return project;
    },

    removeProject: async (projectId) => {
      await request({ type: "project.remove", projectId });
    },

    createThread: async (projectId, model) => {
      return request<ThreadMeta>({ type: "thread.create", projectId, model });
    },

    deleteThread: async (threadId) => {
      await request({ type: "thread.delete", threadId });
      set((s) => {
        const threadStates = { ...s.threadStates };
        delete threadStates[threadId];
        return { threadStates };
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

    updateSettings: async (settings) => {
      await request({ type: "settings.update", settings });
    },

    saveSkill: async (name, description, content) => {
      await request({ type: "skill.save", name, description, content });
    },

    deleteSkill: async (name) => {
      await request({ type: "skill.delete", name });
    },

    searchFiles: async (projectId, query) => {
      return request<string[]>({ type: "files.search", projectId, query });
    },
  };
});

export function useThreadState(threadId: string | undefined): ThreadState {
  return useApp((s) => (threadId ? (s.threadStates[threadId] ?? emptyThread) : emptyThread));
}
