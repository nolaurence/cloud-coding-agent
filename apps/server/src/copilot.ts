import { randomUUID } from "node:crypto";
import { CopilotClient, approveAll } from "@github/copilot-sdk";
import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import type {
  AppSettings,
  ChatMessage,
  ModelRef,
  ThreadEvent,
  ThreadMeta,
  ToolActivity,
} from "@cca/protocol";
import { COPILOT_HOME } from "./env.js";
import { store } from "./store.js";
import { enabledSkillDirectories } from "./skills.js";

interface ThreadRuntime {
  threadId: string;
  session: CopilotSession | null;
  attaching: Promise<CopilotSession> | null;
  messages: ChatMessage[];
  activities: ToolActivity[];
  running: boolean;
  currentTurnId: string | null;
  detachTimer: NodeJS.Timeout | null;
  subscribers: number;
}

export type ThreadEventSink = (threadId: string, event: ThreadEvent) => void;
export type ShellChangedSink = () => void;

const DETACH_IDLE_MS = 10 * 60 * 1000;

export class CopilotManager {
  private client: CopilotClient | null = null;
  private starting: Promise<void> | null = null;
  private threads = new Map<string, ThreadRuntime>();
  private sink: ThreadEventSink = () => {};
  private shellChanged: ShellChangedSink = () => {};

  onThreadEvent(sink: ThreadEventSink) {
    this.sink = sink;
  }

  onShellChanged(sink: ShellChangedSink) {
    this.shellChanged = sink;
  }

  private async ensureClient(): Promise<CopilotClient> {
    if (this.client) return this.client;
    if (!this.starting) {
      this.starting = (async () => {
        const client = new CopilotClient({
          logLevel: "warning",
          env: { ...process.env, COPILOT_HOME },
        });
        await client.start();
        this.client = client;
      })();
    }
    await this.starting;
    return this.client!;
  }

  private runtime(threadId: string): ThreadRuntime {
    let rt = this.threads.get(threadId);
    if (!rt) {
      rt = {
        threadId,
        session: null,
        attaching: null,
        messages: [],
        activities: [],
        running: false,
        currentTurnId: null,
        detachTimer: null,
        subscribers: 0,
      };
      this.threads.set(threadId, rt);
    }
    return rt;
  }

  private emit(threadId: string, event: ThreadEvent) {
    this.sink(threadId, event);
  }

  private buildSessionConfig(thread: ThreadMeta, settings: AppSettings) {
    const modelRef = thread.model ?? settings.defaultModel;
    const providerConfig = modelRef
      ? settings.providers.find((p) => p.id === modelRef.providerId)
      : undefined;

    const mcpServers: Record<string, unknown> = {};
    for (const server of settings.mcpServers) {
      if (!server.enabled) continue;
      if (server.type === "http" && server.url) {
        mcpServers[server.name] = {
          type: "http",
          url: server.url,
          headers: server.headers,
          tools: server.tools.length > 0 ? server.tools : ["*"],
          timeout: server.timeout,
        };
      } else if (server.type === "local" && server.command) {
        mcpServers[server.name] = {
          type: "local",
          command: server.command,
          args: server.args ?? [],
          env: server.env,
          cwd: server.cwd,
          tools: server.tools.length > 0 ? server.tools : ["*"],
          timeout: server.timeout,
        };
      }
    }

    const skills = enabledSkillDirectories();
    const project = store.projects.find((p) => p.id === thread.projectId);

    const config: Record<string, unknown> = {
      sessionId: thread.id,
      streaming: true,
      workingDirectory: project?.path,
      onPermissionRequest: approveAll,
      mcpServers,
    };
    if (skills.dirs.length > 0) {
      config.skillDirectories = skills.dirs;
      config.disabledSkills = skills.disabled;
    }
    if (modelRef) {
      config.model = modelRef.modelId;
      if (providerConfig) {
        config.provider = {
          type: providerConfig.type,
          baseUrl: providerConfig.baseUrl,
          apiKey: providerConfig.apiKey,
          wireApi: providerConfig.wireApi ?? "completions",
          ...(providerConfig.type === "azure"
            ? { azure: { apiVersion: providerConfig.azureApiVersion ?? "2024-10-21" } }
            : {}),
        };
      }
    }
    return config;
  }

  private attachEventHandlers(rt: ThreadRuntime, session: CopilotSession) {
    session.on((event: SessionEvent) => {
      try {
        this.handleSessionEvent(rt, event);
      } catch (err) {
        console.error("event handler error", err);
      }
    });
  }

  private handleSessionEvent(rt: ThreadRuntime, event: SessionEvent) {
    const threadId = rt.threadId;
    const ts = Date.now();
    switch (event.type) {
      case "assistant.turn_start": {
        const turnId = (event.data as { turnId: string }).turnId;
        rt.currentTurnId = turnId;
        this.emit(threadId, { kind: "turn.start", turnId });
        break;
      }
      case "assistant.turn_end": {
        const turnId = (event.data as { turnId: string }).turnId;
        this.emit(threadId, { kind: "turn.end", turnId });
        break;
      }
      case "user.message": {
        const data = event.data as { content: string };
        const turnId = rt.currentTurnId ?? `turn-${randomUUID()}`;
        const message: ChatMessage = {
          id: event.id,
          role: "user",
          text: data.content,
          turnId,
          createdAt: ts,
        };
        rt.messages.push(message);
        this.emit(threadId, { kind: "user.message", message });

        const thread = store.getThread(threadId);
        if (thread && (thread.title === "新会话" || thread.title === "New chat")) {
          const title = data.content.replace(/\s+/g, " ").trim().slice(0, 40) || thread.title;
          store.upsertThread({ ...thread, title, updatedAt: ts });
          this.emit(threadId, { kind: "title", title });
          this.shellChanged();
        }
        break;
      }
      case "assistant.message_delta": {
        const data = event.data as { messageId: string; deltaContent: string };
        this.emit(threadId, {
          kind: "assistant.delta",
          messageId: data.messageId,
          turnId: rt.currentTurnId ?? "",
          delta: data.deltaContent,
        });
        break;
      }
      case "assistant.reasoning_delta": {
        const data = event.data as { reasoningId: string; deltaContent: string };
        this.emit(threadId, {
          kind: "assistant.reasoning_delta",
          messageId: data.reasoningId,
          turnId: rt.currentTurnId ?? "",
          delta: data.deltaContent,
        });
        break;
      }
      case "assistant.message": {
        const data = event.data as { content: string; reasoningText?: string };
        const message: ChatMessage = {
          id: event.id,
          role: "assistant",
          text: data.content,
          reasoning: data.reasoningText,
          turnId: rt.currentTurnId ?? "",
          createdAt: ts,
        };
        rt.messages.push(message);
        this.emit(threadId, { kind: "assistant.message", message });
        break;
      }
      case "tool.execution_start": {
        const data = event.data as {
          toolCallId: string;
          toolName: string;
          arguments?: Record<string, unknown>;
          mcpServerName?: string;
        };
        const activity: ToolActivity = {
          id: data.toolCallId,
          turnId: rt.currentTurnId ?? "",
          toolName: data.mcpServerName ? `${data.mcpServerName}/${data.toolName}` : data.toolName,
          status: "running",
          args: data.arguments ? JSON.stringify(data.arguments) : undefined,
          startedAt: ts,
        };
        rt.activities.push(activity);
        this.emit(threadId, { kind: "tool.start", activity });
        break;
      }
      case "tool.execution_complete": {
        const data = event.data as {
          toolCallId: string;
          success: boolean;
          result?: { content: string; detailedContent?: string };
          error?: { message: string };
        };
        const existing = rt.activities.find((a) => a.id === data.toolCallId);
        const activity: ToolActivity = existing ?? {
          id: data.toolCallId,
          turnId: rt.currentTurnId ?? "",
          toolName: "tool",
          status: "running",
          startedAt: ts,
        };
        activity.status = data.success ? "complete" : "error";
        activity.result = data.success
          ? (data.result?.detailedContent ?? data.result?.content ?? "").slice(0, 4000)
          : (data.error?.message ?? "工具执行失败");
        activity.endedAt = ts;
        if (!existing) rt.activities.push(activity);
        this.emit(threadId, { kind: "tool.complete", activity });
        break;
      }
      case "session.idle": {
        rt.running = false;
        this.emit(threadId, { kind: "turn.end", turnId: rt.currentTurnId ?? "" });
        this.shellChanged();
        break;
      }
      case "session.error": {
        const data = event.data as { message: string };
        rt.running = false;
        this.emit(threadId, { kind: "error", message: data.message });
        this.shellChanged();
        break;
      }
      default:
        break;
    }
  }

  private async attach(threadId: string): Promise<CopilotSession> {
    const rt = this.runtime(threadId);
    if (rt.session) return rt.session;
    if (rt.attaching) return rt.attaching;

    rt.attaching = (async () => {
      const client = await this.ensureClient();
      const thread = store.getThread(threadId);
      if (!thread) throw new Error(`Thread ${threadId} not found`);
      const settings = store.settings;
      const config = this.buildSessionConfig(thread, settings);

      let session: CopilotSession;
      const hasHistory = thread.createdAt < Date.now() - 1000 || rt.messages.length > 0;
      try {
        if (hasHistory) {
          session = await client.resumeSession(threadId, config as never);
        } else {
          throw new Error("create");
        }
      } catch {
        session = await client.createSession(config as never);
      }

      rt.session = session;
      rt.attaching = null;
      this.attachEventHandlers(rt, session);
      if (rt.messages.length === 0) {
        await this.rebuildHistory(rt, session);
      }
      return session;
    })();

    return rt.attaching;
  }

  private async rebuildHistory(rt: ThreadRuntime, session: CopilotSession) {
    try {
      const events = await session.getEvents();
      let turnId = "";
      for (const event of events) {
        const ts = Date.parse(event.timestamp) || Date.now();
        switch (event.type) {
          case "assistant.turn_start":
            turnId = (event.data as { turnId: string }).turnId;
            break;
          case "user.message": {
            const data = event.data as { content: string };
            rt.messages.push({
              id: event.id,
              role: "user",
              text: data.content,
              turnId,
              createdAt: ts,
            });
            break;
          }
          case "assistant.message": {
            const data = event.data as { content: string; reasoningText?: string };
            rt.messages.push({
              id: event.id,
              role: "assistant",
              text: data.content,
              reasoning: data.reasoningText,
              turnId,
              createdAt: ts,
            });
            break;
          }
          case "tool.execution_start": {
            const data = event.data as {
              toolCallId: string;
              toolName: string;
              arguments?: Record<string, unknown>;
            };
            rt.activities.push({
              id: data.toolCallId,
              turnId,
              toolName: data.toolName,
              status: "running",
              args: data.arguments ? JSON.stringify(data.arguments) : undefined,
              startedAt: ts,
            });
            break;
          }
          case "tool.execution_complete": {
            const data = event.data as {
              toolCallId: string;
              success: boolean;
              result?: { content: string; detailedContent?: string };
            };
            const existing = rt.activities.find((a) => a.id === data.toolCallId);
            if (existing) {
              existing.status = data.success ? "complete" : "error";
              existing.result = (data.result?.detailedContent ?? data.result?.content ?? "").slice(0, 4000);
              existing.endedAt = ts;
            }
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      console.error("rebuild history failed", err);
    }
  }

  async subscribe(threadId: string): Promise<ThreadEvent> {
    const rt = this.runtime(threadId);
    rt.subscribers += 1;
    if (rt.detachTimer) {
      clearTimeout(rt.detachTimer);
      rt.detachTimer = null;
    }
    await this.attach(threadId);
    return {
      kind: "snapshot",
      messages: rt.messages,
      activities: rt.activities,
      running: rt.running,
    };
  }

  unsubscribe(threadId: string) {
    const rt = this.threads.get(threadId);
    if (!rt) return;
    rt.subscribers = Math.max(0, rt.subscribers - 1);
    if (rt.subscribers === 0 && !rt.detachTimer) {
      rt.detachTimer = setTimeout(() => {
        void this.detach(threadId);
      }, DETACH_IDLE_MS);
    }
  }

  private async detach(threadId: string) {
    const rt = this.threads.get(threadId);
    if (!rt || rt.subscribers > 0) return;
    try {
      await rt.session?.disconnect();
    } catch {
      // ignore
    }
    this.threads.delete(threadId);
  }

  async sendMessage(
    threadId: string,
    text: string,
    attachments?: { path: string; displayName?: string }[],
  ): Promise<void> {
    const rt = this.runtime(threadId);
    const session = await this.attach(threadId);
    rt.running = true;
    this.shellChanged();
    const thread = store.getThread(threadId);
    if (thread) {
      store.upsertThread({ ...thread, updatedAt: Date.now() });
    }
    await session.send({
      prompt: text,
      attachments: attachments?.map((a) => ({
        type: "file" as const,
        path: a.path,
        displayName: a.displayName,
      })),
    });
  }

  async interrupt(threadId: string): Promise<void> {
    const rt = this.threads.get(threadId);
    if (!rt?.session) return;
    await rt.session.abort();
    rt.running = false;
    this.shellChanged();
  }

  async deleteThread(threadId: string): Promise<void> {
    const rt = this.threads.get(threadId);
    if (rt?.session) {
      try {
        await rt.session.disconnect();
      } catch {
        // ignore
      }
    }
    this.threads.delete(threadId);
    try {
      const client = await this.ensureClient();
      await client.deleteSession(threadId);
    } catch {
      // ignore
    }
  }

  async listModels() {
    const client = await this.ensureClient();
    try {
      const models = await client.listModels();
      return models.map((m) => ({ id: m.id, name: m.name }));
    } catch {
      return [];
    }
  }

  isRunning(threadId: string): boolean {
    return this.threads.get(threadId)?.running ?? false;
  }

  runningThreadIds(): string[] {
    return [...this.threads.values()].filter((t) => t.running).map((t) => t.threadId);
  }

  async reconfigureOpenSessions() {
    for (const rt of this.threads.values()) {
      await this.detach(rt.threadId);
    }
  }

  async shutdown() {
    for (const rt of this.threads.values()) {
      try {
        await rt.session?.disconnect();
      } catch {
        // ignore
      }
    }
    if (this.client) {
      await this.client.stop();
      this.client = null;
      this.starting = null;
    }
  }
}
