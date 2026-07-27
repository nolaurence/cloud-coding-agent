import { randomUUID } from "node:crypto";
import { CopilotClient } from "@github/copilot-sdk";
import type { CopilotSession, SessionEvent } from "@github/copilot-sdk";
import { isReasoningEffort, normalizeReasoningEfforts } from "@cca/protocol";
import type {
  AppSettings,
  ChatMessage,
  MessageAttachment,
  ModelRef,
  ThreadEvent,
  ThreadMeta,
  ToolActivity,
  TurnAttachment,
} from "@cca/protocol";
import { COPILOT_HOME } from "./env.js";
import { store } from "./store.js";
import { enabledSkillDirectories } from "./skills.js";
import { createAuthenticatedGitTool } from "./gitOperations.js";
import { createWorkspacePermissionHandler } from "./permissions.js";

interface ThreadRuntime {
  threadId: string;
  session: CopilotSession | null;
  attaching: Promise<CopilotSession> | null;
  messages: ChatMessage[];
  activities: ToolActivity[];
  running: boolean;
  currentTurnId: string | null;
  pendingAssistant: {
    messageId: string | null;
    turnId: string;
    text: string;
    reasoning: string;
    startedAt: number;
  } | null;
  pendingUserAttachments: MessageAttachment[];
  pendingUserAuthorId: string;
  sessionActorId: string;
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
type CopilotSetModelOptions = NonNullable<Parameters<CopilotSession["setModel"]>[1]>;
type CopilotReasoningEffort = NonNullable<CopilotSetModelOptions["reasoningEffort"]>;

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
        pendingAssistant: null,
        pendingUserAttachments: [],
        pendingUserAuthorId: "",
        sessionActorId: "",
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

  private ensurePendingAssistant(
    rt: ThreadRuntime,
    turnId: string,
    startedAt: number,
    messageId?: string,
    emitPrevious = true,
  ) {
    const pending = rt.pendingAssistant;
    if (
      pending &&
      (pending.turnId !== turnId ||
        (messageId && pending.messageId && pending.messageId !== messageId))
    ) {
      this.commitPendingAssistant(rt, emitPrevious);
    }
    if (!rt.pendingAssistant) {
      rt.pendingAssistant = {
        messageId: messageId ?? null,
        turnId,
        text: "",
        reasoning: "",
        startedAt,
      };
    } else if (messageId && !rt.pendingAssistant.messageId) {
      rt.pendingAssistant.messageId = messageId;
    }
    return rt.pendingAssistant;
  }

  private commitPendingAssistant(rt: ThreadRuntime, emit = true) {
    const pending = rt.pendingAssistant;
    rt.pendingAssistant = null;
    if (!pending || (!pending.text && !pending.reasoning)) return;

    const message: ChatMessage = {
      id: pending.messageId ?? `partial-${pending.turnId || "turn"}`,
      role: "assistant",
      text: pending.text,
      reasoning: pending.reasoning || undefined,
      turnId: pending.turnId,
      createdAt: pending.startedAt,
    };
    const index = rt.messages.findIndex((candidate) => candidate.id === message.id);
    if (index >= 0) rt.messages[index] = message;
    else rt.messages.push(message);
    if (emit) this.emit(rt.threadId, { kind: "assistant.message", message });
  }

  private buildSessionConfig(thread: ThreadMeta, settings: AppSettings, actorId: string) {
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
    const disableApplyPatch =
      providerConfig?.type === "openai" &&
      (providerConfig.wireApi ?? "completions") === "responses";
    const systemInstructions = [
      "GitHub 或 Gitee 的 clone、fetch、pull、push 需要远程认证时,必须使用 authenticated_git 工具。不要向用户索取、读取或输出访问令牌。",
    ];
    if (disableApplyPatch) {
      systemInstructions.push(
        "The apply_patch tool is unavailable. Use another available file editing tool.",
      );
    }

    const config: Record<string, unknown> = {
      sessionId: thread.id,
      streaming: true,
      includeSubAgentStreamingEvents: false,
      workingDirectory: project.path,
      onPermissionRequest: createWorkspacePermissionHandler(project.path),
      mcpServers,
      tools: [createAuthenticatedGitTool(actorId || thread.userId, project.path)],
      systemMessage: {
        mode: "append",
        content: systemInstructions.join("\n"),
      },
    };
    if (disableApplyPatch) {
      // Some Responses-compatible gateways drop free-form custom-tool input.
      config.excludedTools = ["builtin:apply_patch"];
    }
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
      if (rt.session !== session) return;
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
    this.commitPendingAssistant(rt);
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
          authorId: rt.pendingUserAuthorId || undefined,
          attachments: rt.pendingUserAttachments.length > 0 ? rt.pendingUserAttachments : undefined,
          turnId,
          createdAt: ts,
        };
        rt.pendingUserAttachments = [];
        rt.pendingUserAuthorId = "";
        rt.messages.push(message);
        this.emit(threadId, { kind: "user.message", message });

        const thread = store.getThread(threadId);
        if (thread) {
          const title =
            thread.title === "新会话" || thread.title === "New chat"
              ? data.content.replace(/\s+/g, " ").trim().slice(0, 40) || thread.title
              : thread.title;
          store.upsertThread({
            ...thread,
            title,
            messageAttachments: {
              ...thread.messageAttachments,
              ...(message.attachments ? { [message.id]: message.attachments } : {}),
            },
            messageAuthors: {
              ...thread.messageAuthors,
              ...(message.authorId ? { [message.id]: message.authorId } : {}),
            },
            updatedAt: ts,
          });
          if (title !== thread.title) {
            this.emit(threadId, { kind: "title", title });
            this.shellChanged();
          }
        }
        break;
      }
      case "assistant.message_delta": {
        if (event.agentId) break;
        const data = event.data;
        const pending = this.ensurePendingAssistant(
          rt,
          rt.currentTurnId ?? "",
          ts,
          data.messageId,
        );
        pending.text += data.deltaContent;
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
        const pending = this.ensurePendingAssistant(rt, rt.currentTurnId ?? "", ts);
        pending.reasoning += data.deltaContent;
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
        rt.pendingAssistant = null;
        const partialId = `partial-${message.turnId || "turn"}`;
        rt.messages = rt.messages.filter((candidate) => candidate.id !== partialId);
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

  private async attach(threadId: string, actorId?: string): Promise<CopilotSession> {
    const rt = this.runtime(threadId);
    const thread = store.getThread(threadId);
    if (!thread) throw new Error("会话不存在");
    const requestedActorId = actorId || thread.userId || "";
    if (rt.session && rt.sessionActorId === requestedActorId) return rt.session;
    if (rt.attaching) {
      await rt.attaching;
      if (rt.session && rt.sessionActorId === requestedActorId) return rt.session;
    }
    if (rt.session) {
      const previousSession = rt.session;
      rt.session = null;
      rt.sessionActorId = "";
      await previousSession.disconnect().catch(() => {});
    }

    const attaching = (async () => {
      const client = await this.ensureClient();
      const settings = store.settings;
      const config = this.buildSessionConfig(thread, settings, requestedActorId);

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
      rt.sessionActorId = requestedActorId;
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
      rt.pendingAssistant = null;
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
            this.commitPendingAssistant(rt, false);
            const data = event.data;
            turnId = `turn-${randomUUID()}`;
            rt.messages.push({
              id: event.id,
              role: "user",
              text: data.content,
              authorId: store.getThread(rt.threadId)?.messageAuthors?.[event.id],
              attachments: store.getThread(rt.threadId)?.messageAttachments?.[event.id],
              turnId,
              createdAt: ts,
            });
            break;
          }
          case "assistant.message_delta": {
            if (event.agentId) break;
            const data = event.data;
            const pending = this.ensurePendingAssistant(
              rt,
              turnId,
              ts,
              data.messageId,
              false,
            );
            pending.text += data.deltaContent;
            break;
          }
          case "assistant.reasoning_delta": {
            if (event.agentId) break;
            const pending = this.ensurePendingAssistant(rt, turnId, ts, undefined, false);
            pending.reasoning += event.data.deltaContent;
            break;
          }
          case "assistant.message": {
            if (event.agentId) break;
            const data = event.data;
            if (!data.content && !data.reasoningText) break;
            rt.pendingAssistant = null;
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
      this.commitPendingAssistant(rt, false);
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

  async subscribe(threadId: string, actorId?: string): Promise<ThreadEvent> {
    const rt = this.runtime(threadId);
    rt.subscribers += 1;
    if (rt.detachTimer) {
      clearTimeout(rt.detachTimer);
      rt.detachTimer = null;
    }
    try {
      if (!rt.session && rt.attaching) await rt.attaching;
      if (!rt.session) await this.attach(threadId, actorId);
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
      live: rt.pendingAssistant
        ? {
            text: rt.pendingAssistant.text,
            reasoning: rt.pendingAssistant.reasoning,
            turnId: rt.pendingAssistant.turnId,
            startedAt: rt.pendingAssistant.startedAt,
          }
        : undefined,
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
    attachments?: TurnAttachment[],
    actorId = "",
  ): Promise<void> {
    const rt = this.runtime(threadId);
    if (rt.running) throw new Error("当前任务仍在运行,请等待完成或先停止任务");

    const turnId = `turn-${randomUUID()}`;
    rt.running = true;
    rt.currentTurnId = turnId;
    rt.pendingAssistant = null;
    rt.pendingUserAttachments =
      attachments
        ?.filter((attachment): attachment is TurnAttachment & { imageId: string } => Boolean(attachment.imageId))
        .map((attachment) => ({
          id: attachment.imageId,
          displayName: attachment.displayName ?? "图片",
          kind: "image" as const,
          ownerId: actorId,
        })) ?? [];
    rt.pendingUserAuthorId = actorId;
    this.emit(threadId, { kind: "turn.start", turnId });
    this.shellChanged();
    try {
      const session = await this.attach(threadId, actorId);
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
        rt.pendingUserAttachments = [];
        rt.pendingUserAuthorId = "";
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

    const currentProviderId = currentModel?.providerId ?? "copilot";
    if (currentProviderId === nextModel.providerId) {
      if (!session) return;
      await session.setModel(
        nextModel.modelId,
        nextModel.reasoningEffort
          ? {
              // SDK 1.0.8 omits "none" and "max", but the bundled CLI RPC accepts both.
              reasoningEffort: nextModel.reasoningEffort as CopilotReasoningEffort,
            }
          : undefined,
      );
      return;
    }

    // 跨 provider 热切换不可靠:CLI resume 已有 session 时不保证应用新的 provider,
    // 因此只要会话已有历史或已附加 session 就直接拒绝,提示用户新建会话。
    // 全新空会话除外:下次发送时会按新 provider 直接创建会话。
    const thread = store.getThread(threadId);
    const hasHistory =
      rt.messages.length > 0 || (!!thread && thread.createdAt < Date.now() - 1000);
    if (session || hasHistory) {
      throw new Error("会话内不支持切换模型提供方,请新建会话使用该模型");
    }
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
          ? normalizeReasoningEfforts(m.supportedReasoningEfforts)
          : [],
        defaultReasoningEffort: isReasoningEffort(m.defaultReasoningEffort)
          ? m.defaultReasoningEffort
          : undefined,
      }));
    } catch {
      return [];
    }
  }

  isRunning(threadId: string): boolean {
    return this.threads.get(threadId)?.running ?? false;
  }

  // 后台预热插件市场缓存,避免用户首次打开插件页时等待市场仓库克隆
  async warmupPlugins(): Promise<void> {
    try {
      const marketplaces = await this.listPluginMarketplaces();
      await Promise.allSettled(
        marketplaces.map((m) => this.browsePluginMarketplace(m.name)),
      );
    } catch (error) {
      console.warn("[cca] 插件市场预热失败", error);
    }
  }

  async listPluginMarketplaces() {
    const client = await this.ensureClient();
    const result = await client.rpc.plugins.marketplaces.list();
    return result.marketplaces.map((m) => ({
      name: m.name,
      source: m.source,
      isDefault: m.isDefault ?? false,
    }));
  }

  async addPluginMarketplace(source: string) {
    const client = await this.ensureClient();
    const result = await client.rpc.plugins.marketplaces.add({ source });
    return { name: result.name };
  }

  async removePluginMarketplace(name: string, force: boolean) {
    const client = await this.ensureClient();
    const result = await client.rpc.plugins.marketplaces.remove({ name, force });
    return { removed: result.removed, dependentPlugins: result.dependentPlugins ?? [] };
  }

  async browsePluginMarketplace(name: string) {
    const client = await this.ensureClient();
    const result = await client.rpc.plugins.marketplaces.browse({ name });
    return result.plugins.map((p) => ({ name: p.name, description: p.description ?? "" }));
  }

  async listInstalledPlugins() {
    const client = await this.ensureClient();
    const result = await client.rpc.plugins.list();
    return result.plugins.map((p) => ({
      name: p.name,
      marketplace: p.marketplace,
      version: p.version,
      enabled: p.enabled,
      directSourceId: p.directSourceId,
    }));
  }

  async installPlugin(source: string) {
    const client = await this.ensureClient();
    const result = await client.rpc.plugins.install({ source });
    return {
      plugin: {
        name: result.plugin.name,
        marketplace: result.plugin.marketplace,
        version: result.plugin.version,
        enabled: result.plugin.enabled,
        directSourceId: result.plugin.directSourceId,
      },
      skillsInstalled: result.skillsInstalled,
      postInstallMessage: result.postInstallMessage,
      deprecationWarning: result.deprecationWarning,
    };
  }

  async uninstallPlugin(name: string, directSourceId?: string) {
    const client = await this.ensureClient();
    await client.rpc.plugins.uninstall({ name, directSourceId: directSourceId ?? null });
  }

  async setPluginEnabled(name: string, enabled: boolean) {
    const client = await this.ensureClient();
    if (enabled) {
      await client.rpc.plugins.enable({ names: [name] });
    } else {
      await client.rpc.plugins.disable({ names: [name] });
    }
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
