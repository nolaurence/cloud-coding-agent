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
export type CopilotClientFactory = () => CopilotClient;

const DETACH_IDLE_MS = 10 * 60 * 1000;
const MAX_TOOL_RESULT_CHARS = 16_000;

type ToolStartData = Extract<SessionEvent, { type: "tool.execution_start" }>["data"];
type ToolCompleteData = Extract<SessionEvent, { type: "tool.execution_complete" }>["data"];

function stringifyArguments(args: ToolStartData["arguments"]): string | undefined {
  if (!args) return undefined;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

function toolResult(data: ToolCompleteData): string | undefined {
  const value = data.success
    ? data.result?.detailedContent ?? data.result?.content
    : data.error?.message ?? data.result?.detailedContent ?? data.result?.content ?? "工具执行失败";
  return value ? value.slice(0, MAX_TOOL_RESULT_CHARS) : undefined;
}

function activityName(data: ToolStartData): string {
  const toolName = data.mcpToolName ?? data.toolName;
  return data.mcpServerName ? `${data.mcpServerName}/${toolName}` : toolName;
}

export class CopilotManager {
  private client: CopilotClient | null = null;
  private starting: Promise<void> | null = null;
  private threads = new Map<string, ThreadRuntime>();
  private sink: ThreadEventSink = () => {};
  private shellChanged: ShellChangedSink = () => {};

  constructor(
    private readonly createClient: CopilotClientFactory = () =>
      new CopilotClient({
        logLevel: "warning",
        env: { ...process.env, COPILOT_HOME },
      }),
  ) {}

  onThreadEvent(sink: ThreadEventSink) {
    this.sink = sink;
  }

  onShellChanged(sink: ShellChangedSink) {
    this.shellChanged = sink;
  }

  private async ensureClient(): Promise<CopilotClient> {
    if (this.client) return this.client;
    if (!this.starting) {
      const starting = (async () => {
        const client = this.createClient();
        await client.start();
        this.client = client;
      })();
      this.starting = starting;
      void starting.then(
        () => {
          if (this.starting === starting) this.starting = null;
        },
        () => {
          if (this.starting === starting) this.starting = null;
        },
      );
    }
    await this.starting;
    if (!this.client) throw new Error("Copilot 客户端启动失败");
    return this.client;
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
          workingDirectory: server.cwd,
          tools: server.tools.length > 0 ? server.tools : ["*"],
          timeout: server.timeout,
        };
      }
    }

    const skills = enabledSkillDirectories();
    const project = store.projects.find((p) => p.id === thread.projectId);
    if (!project) throw new Error("会话关联的项目不存在");

    const config: Record<string, unknown> = {
      sessionId: thread.id,
      streaming: true,
      includeSubAgentStreamingEvents: false,
      workingDirectory: project.path,
      onPermissionRequest: approveAll,
      mcpServers,
    };
    if (skills.dirs.length > 0) {
      config.skillDirectories = skills.dirs;
      config.disabledSkills = skills.disabled;
    }
    if (modelRef) {
      config.model = modelRef.modelId;
      if (modelRef.reasoningEffort) {
        config.reasoningEffort = modelRef.reasoningEffort;
      }
      if (providerConfig) {
        config.provider = {
          type: providerConfig.type,
          baseUrl: providerConfig.baseUrl.trim(),
          apiKey: providerConfig.apiKey?.trim() || undefined,
          ...(providerConfig.type !== "anthropic"
            ? { wireApi: providerConfig.wireApi ?? "completions" }
            : {}),
          ...(providerConfig.type === "openai"
            ? { headers: { "User-Agent": "cloud-coding-agent/0.1" } }
            : {}),
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

  private finishTurn(rt: ThreadRuntime) {
    if (!rt.running) return;
    const turnId = rt.currentTurnId ?? "";
    rt.running = false;
    rt.currentTurnId = null;
    this.emit(rt.threadId, { kind: "turn.end", turnId });
    this.shellChanged();
  }

  private failRunningTools(rt: ThreadRuntime, message: string, endedAt: number) {
    for (const activity of rt.activities) {
      if (activity.status !== "running") continue;
      activity.status = "error";
      activity.result = message;
      activity.endedAt = endedAt;
      this.emit(rt.threadId, { kind: "tool.complete", activity });
    }
  }

  private handleSessionEvent(rt: ThreadRuntime, event: SessionEvent) {
    const threadId = rt.threadId;
    const ts = Date.parse(event.timestamp) || Date.now();
    switch (event.type) {
      case "assistant.turn_start": {
        if (event.agentId) break;
        const turnId = rt.currentTurnId ?? event.data.turnId;
        rt.currentTurnId = turnId;
        if (!rt.running) {
          rt.running = true;
          this.emit(threadId, { kind: "turn.start", turnId });
          this.shellChanged();
        }
        break;
      }
      case "assistant.turn_end": {
        // A single user request can contain several assistant turns separated by tools.
        // session.idle is the authoritative end of the complete request.
        break;
      }
      case "user.message": {
        if (event.agentId) break;
        const data = event.data;
        const turnId = rt.currentTurnId ?? `turn-${randomUUID()}`;
        rt.currentTurnId = turnId;
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
        if (event.agentId) break;
        const data = event.data;
        this.emit(threadId, {
          kind: "assistant.delta",
          messageId: data.messageId,
          turnId: rt.currentTurnId ?? "",
          delta: data.deltaContent,
        });
        break;
      }
      case "assistant.reasoning_delta": {
        if (event.agentId) break;
        const data = event.data;
        this.emit(threadId, {
          kind: "assistant.reasoning_delta",
          messageId: data.reasoningId,
          turnId: rt.currentTurnId ?? "",
          delta: data.deltaContent,
        });
        break;
      }
      case "assistant.message": {
        if (event.agentId) break;
        const data = event.data;
        if (!data.content && !data.reasoningText) break;
        const message: ChatMessage = {
          id: data.messageId,
          role: "assistant",
          text: data.content,
          reasoning: data.reasoningText,
          turnId: rt.currentTurnId ?? data.turnId ?? "",
          createdAt: ts,
        };
        const index = rt.messages.findIndex((candidate) => candidate.id === message.id);
        if (index >= 0) rt.messages[index] = message;
        else rt.messages.push(message);
        this.emit(threadId, { kind: "assistant.message", message });
        break;
      }
      case "tool.execution_start": {
        const data = event.data;
        const activity: ToolActivity = {
          id: data.toolCallId,
          turnId: rt.currentTurnId ?? "",
          toolName: activityName(data),
          status: "running",
          args: stringifyArguments(data.arguments),
          startedAt: ts,
        };
        const index = rt.activities.findIndex((candidate) => candidate.id === activity.id);
        if (index >= 0) rt.activities[index] = activity;
        else rt.activities.push(activity);
        this.emit(threadId, { kind: "tool.start", activity });
        break;
      }
      case "tool.execution_complete": {
        const data = event.data;
        const existing = rt.activities.find((a) => a.id === data.toolCallId);
        const activity: ToolActivity = existing ?? {
          id: data.toolCallId,
          turnId: rt.currentTurnId ?? "",
          toolName: data.toolDescription?.name ?? "tool",
          status: "running",
          startedAt: ts,
        };
        activity.status = data.success ? "complete" : "error";
        activity.result = toolResult(data);
        activity.endedAt = ts;
        if (!existing) rt.activities.push(activity);
        this.emit(threadId, { kind: "tool.complete", activity });
        break;
      }
      case "session.idle": {
        if (event.agentId) break;
        this.failRunningTools(rt, event.data.aborted ? "工具执行已中止" : "工具执行未正常结束", ts);
        this.finishTurn(rt);
        break;
      }
      case "session.error": {
        if (event.agentId) break;
        this.failRunningTools(rt, event.data.message, ts);
        this.emit(threadId, { kind: "error", message: event.data.message });
        this.finishTurn(rt);
        break;
      }
      case "abort": {
        if (event.agentId) break;
        this.failRunningTools(rt, "工具执行已中止", ts);
        this.finishTurn(rt);
        break;
      }
      case "session.shutdown": {
        if (event.agentId) break;
        this.failRunningTools(rt, "会话已断开", ts);
        this.finishTurn(rt);
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

    const attaching = (async () => {
      const client = await this.ensureClient();
      const thread = store.getThread(threadId);
      if (!thread) throw new Error("会话不存在");
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
      this.attachEventHandlers(rt, session);
      if (rt.messages.length === 0) {
        await this.rebuildHistory(rt, session);
      }
      return session;
    })();
    rt.attaching = attaching;

    try {
      return await attaching;
    } finally {
      if (rt.attaching === attaching) rt.attaching = null;
    }
  }

  private async rebuildHistory(rt: ThreadRuntime, session: CopilotSession) {
    try {
      const events = await session.getEvents();
      let turnId = "";
      let lastTimestamp = Date.now();
      for (const event of events) {
        const ts = Date.parse(event.timestamp) || Date.now();
        lastTimestamp = ts;
        switch (event.type) {
          case "assistant.turn_start":
            if (!event.agentId && !turnId) turnId = event.data.turnId;
            break;
          case "user.message": {
            if (event.agentId) break;
            const data = event.data;
            turnId = `turn-${randomUUID()}`;
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
            if (event.agentId) break;
            const data = event.data;
            if (!data.content && !data.reasoningText) break;
            rt.messages.push({
              id: data.messageId,
              role: "assistant",
              text: data.content,
              reasoning: data.reasoningText,
              turnId,
              createdAt: ts,
            });
            break;
          }
          case "tool.execution_start": {
            const data = event.data;
            rt.activities.push({
              id: data.toolCallId,
              turnId,
              toolName: activityName(data),
              status: "running",
              args: stringifyArguments(data.arguments),
              startedAt: ts,
            });
            break;
          }
          case "tool.execution_complete": {
            const data = event.data;
            const existing = rt.activities.find((a) => a.id === data.toolCallId);
            const activity: ToolActivity = existing ?? {
              id: data.toolCallId,
              turnId,
              toolName: data.toolDescription?.name ?? "tool",
              status: "running",
              startedAt: ts,
            };
            activity.status = data.success ? "complete" : "error";
            activity.result = toolResult(data);
            activity.endedAt = ts;
            if (!existing) rt.activities.push(activity);
            break;
          }
          default:
            break;
        }
      }
      for (const activity of rt.activities) {
        if (activity.status !== "running") continue;
        activity.status = "error";
        activity.result = "工具执行被中断";
        activity.endedAt = lastTimestamp;
      }
      rt.currentTurnId = null;
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
    try {
      await this.attach(threadId);
    } catch (error) {
      rt.subscribers = Math.max(0, rt.subscribers - 1);
      if (rt.subscribers === 0 && !rt.session) this.threads.delete(threadId);
      throw error;
    }
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
    if (rt.running) throw new Error("当前任务仍在运行,请等待完成或先停止任务");

    const turnId = `turn-${randomUUID()}`;
    rt.running = true;
    rt.currentTurnId = turnId;
    this.emit(threadId, { kind: "turn.start", turnId });
    this.shellChanged();
    try {
      const session = await this.attach(threadId);
      await session.send({
        prompt: text,
        attachments: attachments?.map((a) => ({
          type: "file" as const,
          path: a.path,
          displayName: a.displayName,
        })),
      });
      const thread = store.getThread(threadId);
      if (thread) store.upsertThread({ ...thread, updatedAt: Date.now() });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (rt.running) {
        this.emit(threadId, { kind: "error", message });
        this.finishTurn(rt);
      }
      throw error;
    }
  }

  async interrupt(threadId: string): Promise<void> {
    const rt = this.threads.get(threadId);
    if (!rt?.running) return;
    try {
      const session = rt.session ?? (rt.attaching ? await rt.attaching : null);
      await session?.abort();
    } finally {
      this.failRunningTools(rt, "工具执行已中止", Date.now());
      this.finishTurn(rt);
    }
  }

  async setThreadModel(
    threadId: string,
    currentModel: ModelRef | undefined,
    nextModel: ModelRef,
  ): Promise<void> {
    const rt = this.threads.get(threadId);
    if (!rt) return;
    if (rt.running) throw new Error("当前任务运行中,请等待完成后再切换模型或推理强度");

    const session = rt.session ?? (rt.attaching ? await rt.attaching : null);
    if (!session) return;

    const currentProviderId = currentModel?.providerId ?? "copilot";
    if (currentProviderId === nextModel.providerId) {
      await session.setModel(
        nextModel.modelId,
        nextModel.reasoningEffort ? { reasoningEffort: nextModel.reasoningEffort } : undefined,
      );
      return;
    }

    await session.disconnect();
    rt.session = null;
    rt.attaching = null;
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
      return models.map((m) => ({
        id: m.id,
        name: m.name,
        supportedReasoningEfforts: m.capabilities.supports.reasoningEffort
          ? m.supportedReasoningEfforts
          : [],
        defaultReasoningEffort: m.defaultReasoningEffort,
      }));
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
    if ([...this.threads.values()].some((rt) => rt.running)) {
      throw new Error("当前仍有任务运行,请停止或等待完成后再修改模型、MCP 或技能配置");
    }
    for (const rt of this.threads.values()) {
      const session = rt.session ?? (rt.attaching ? await rt.attaching : null);
      rt.session = null;
      rt.attaching = null;
      if (!session) continue;
      try {
        await session.disconnect();
      } catch (error) {
        console.error(`reconfigure session ${rt.threadId} failed`, error);
      }
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
