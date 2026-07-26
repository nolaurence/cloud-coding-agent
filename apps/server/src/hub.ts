import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  AppSettings,
  ClientMessage,
  ModelOption,
  ModelRef,
  ServerMessage,
  ShellState,
  ThreadMeta,
} from "@cca/protocol";
import { store } from "./store.js";
import { CopilotManager } from "./copilot.js";
import { searchFiles } from "./files.js";
import { browseDirectories, resolveProjectDirectory } from "./directories.js";
import { deleteSkill, listSkills, saveSkill } from "./skills.js";
import { flattenModels, isReasoningEffort, normalizeModelRefReasoning } from "@cca/protocol";
import { verifyToken, type TokenPayload } from "./auth.js";
import { discoverProviderModels } from "./providers.js";

interface ClientConn {
  socket: WebSocket;
  user: TokenPayload;
  shellSubscribed: boolean;
  threadSubs: Set<string>;
}

export class Hub {
  private clients = new Set<ClientConn>();
  private manager = new CopilotManager();

  constructor() {
    this.manager.onThreadEvent((threadId, event) => {
      this.broadcastThread(threadId, event);
    });
    this.manager.onShellChanged(() => {
      this.broadcastShell();
    });
  }

  handleConnection(socket: WebSocket, token: string | undefined) {
    const user = token ? verifyToken(token) : null;
    if (!user) {
      socket.send(JSON.stringify({ type: "auth.error", message: "未授权,请重新登录" }));
      socket.close(4401, "unauthorized");
      return;
    }
    const conn: ClientConn = { socket, user, shellSubscribed: false, threadSubs: new Set() };
    this.clients.add(conn);
    socket.on("message", (raw) => {
      void this.onMessage(conn, raw.toString()).catch((err) => {
        console.error("message error", err);
      });
    });
    socket.on("close", () => {
      for (const threadId of conn.threadSubs) {
        this.manager.unsubscribe(threadId);
      }
      this.clients.delete(conn);
    });
  }

  private canAccess(conn: ClientConn, thread: ThreadMeta | undefined): boolean {
    if (!thread) return false;
    if (conn.user.role === "admin") return true;
    return !thread.userId || thread.userId === conn.user.username;
  }

  private requireAdmin(conn: ClientConn) {
    if (conn.user.role !== "admin") throw new Error("仅管理员可以管理项目目录");
  }

  private send(conn: ClientConn, msg: ServerMessage) {
    if (conn.socket.readyState === conn.socket.OPEN) {
      conn.socket.send(JSON.stringify(msg));
    }
  }

  private reply(conn: ClientConn, id: string, data?: unknown) {
    this.send(conn, { type: "reply", id, ok: true, data });
  }

  private replyError(conn: ClientConn, id: string, error: unknown) {
    this.send(conn, {
      type: "reply",
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private shellState(conn: ClientConn): ShellState {
    return {
      projects: store.projects,
      threads: [...store.threads]
        .filter((t) => this.canAccess(conn, t))
        .sort((a, b) => b.updatedAt - a.updatedAt),
      runningThreadIds: this.manager.runningThreadIds(),
    };
  }

  broadcastShell() {
    for (const conn of this.clients) {
      if (conn.shellSubscribed) this.send(conn, { type: "shell", data: this.shellState(conn) });
    }
  }

  private broadcastThread(threadId: string, event: import("@cca/protocol").ThreadEvent) {
    const thread = store.getThread(threadId);
    for (const conn of this.clients) {
      if (conn.threadSubs.has(threadId) && this.canAccess(conn, thread)) {
        this.send(conn, { type: "thread.event", threadId, event });
      }
    }
  }

  private broadcastSettings() {
    for (const conn of this.clients) {
      if (conn.shellSubscribed) this.send(conn, { type: "settings", data: store.settings });
    }
  }

  private broadcastSkills() {
    const skills = listSkills();
    for (const conn of this.clients) {
      if (conn.shellSubscribed) this.send(conn, { type: "skills", data: skills });
    }
  }

  private async listModelOptions(settings: AppSettings = store.settings): Promise<ModelOption[]> {
    let models: Awaited<ReturnType<CopilotManager["listModels"]>> = [];
    try {
      models = await this.manager.listModels();
    } catch {
      // Configured providers remain usable when Copilot authentication is unavailable.
    }
    const copilotModels: ModelOption[] = models.map((model) => ({
      ref: { providerId: "copilot", modelId: model.id },
      label: `GitHub Copilot / ${model.name ?? model.id}`,
      supportedReasoningEfforts: model.supportedReasoningEfforts,
      defaultReasoningEffort: model.defaultReasoningEffort,
    }));
    const configuredModels = flattenModels(settings, copilotModels);
    return [...configuredModels, ...copilotModels];
  }

  private async validateReasoningEffort(
    model: ModelRef,
    settings: AppSettings = store.settings,
    modelOptions?: readonly ModelOption[],
  ): Promise<void> {
    const effort: unknown = model.reasoningEffort;
    if (effort === undefined) return;
    if (!isReasoningEffort(effort)) throw new Error("不支持的推理强度");

    const option = (modelOptions ?? (await this.listModelOptions(settings))).find(
      (candidate) =>
        candidate.ref.providerId === model.providerId && candidate.ref.modelId === model.modelId,
    );
    if (
      option?.supportedReasoningEfforts !== undefined &&
      !option.supportedReasoningEfforts.includes(effort)
    ) {
      throw new Error("当前模型不支持该推理强度");
    }
  }

  private async onMessage(conn: ClientConn, raw: string) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }

    try {
      switch (msg.type) {
        case "shell.subscribe": {
          conn.shellSubscribed = true;
          this.send(conn, { type: "shell", data: this.shellState(conn) });
          this.send(conn, { type: "settings", data: store.settings });
          this.send(conn, { type: "skills", data: listSkills() });
          this.reply(conn, msg.id);
          break;
        }
        case "directories.browse": {
          this.requireAdmin(conn);
          this.reply(conn, msg.id, await browseDirectories(msg.partialPath));
          break;
        }
        case "project.add": {
          this.requireAdmin(conn);
          const projectPath = await resolveProjectDirectory(msg.path);
          const name = msg.name?.trim() || projectPath.split(/[\\/]/).filter(Boolean).pop() || projectPath;
          const project = { id: randomUUID(), name, path: projectPath };
          store.addProject(project);
          this.broadcastShell();
          this.reply(conn, msg.id, project);
          break;
        }
        case "project.remove": {
          this.requireAdmin(conn);
          store.removeProject(msg.projectId);
          this.broadcastShell();
          this.reply(conn, msg.id);
          break;
        }
        case "thread.create": {
          if (!store.projects.some((project) => project.id === msg.projectId)) {
            throw new Error("项目不存在");
          }
          const requestedModel = msg.model ?? store.settings.defaultModel;
          let model = requestedModel;
          if (requestedModel) {
            const modelOptions = await this.listModelOptions();
            if (store.normalizeStoredReasoningEfforts(modelOptions)) {
              this.broadcastSettings();
              this.broadcastShell();
            }
            model = normalizeModelRefReasoning(requestedModel, modelOptions);
            await this.validateReasoningEffort(model, store.settings, modelOptions);
          }
          const thread: ThreadMeta = {
            id: randomUUID(),
            projectId: msg.projectId,
            title: "新会话",
            model,
            userId: conn.user.username,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            archived: false,
          };
          store.upsertThread(thread);
          this.broadcastShell();
          this.reply(conn, msg.id, thread);
          break;
        }
        case "thread.delete": {
          if (!this.canAccess(conn, store.getThread(msg.threadId))) throw new Error("无权操作该会话");
          await this.manager.deleteThread(msg.threadId);
          store.deleteThread(msg.threadId);
          this.broadcastShell();
          this.reply(conn, msg.id);
          break;
        }
        case "thread.setModel": {
          const thread = store.getThread(msg.threadId);
          if (!thread) throw new Error("会话不存在");
          if (!this.canAccess(conn, thread)) throw new Error("无权操作该会话");
          await this.validateReasoningEffort(msg.model);
          await this.manager.setThreadModel(
            msg.threadId,
            thread.model ?? store.settings.defaultModel,
            msg.model,
          );
          store.upsertThread({ ...thread, model: msg.model });
          this.broadcastShell();
          this.reply(conn, msg.id);
          break;
        }
        case "thread.subscribe": {
          if (!this.canAccess(conn, store.getThread(msg.threadId))) throw new Error("无权访问该会话");
          if (conn.threadSubs.has(msg.threadId)) {
            this.reply(conn, msg.id);
            break;
          }
          const snapshot = await this.manager.subscribe(msg.threadId);
          conn.threadSubs.add(msg.threadId);
          this.send(conn, { type: "thread.event", threadId: msg.threadId, event: snapshot });
          this.reply(conn, msg.id);
          break;
        }
        case "thread.unsubscribe": {
          if (conn.threadSubs.delete(msg.threadId)) this.manager.unsubscribe(msg.threadId);
          this.reply(conn, msg.id);
          break;
        }
        case "turn.start": {
          if (!this.canAccess(conn, store.getThread(msg.threadId))) throw new Error("无权操作该会话");
          await this.manager.sendMessage(msg.threadId, msg.text, msg.attachments);
          this.broadcastShell();
          this.reply(conn, msg.id);
          break;
        }
        case "turn.interrupt": {
          if (!this.canAccess(conn, store.getThread(msg.threadId))) throw new Error("无权操作该会话");
          await this.manager.interrupt(msg.threadId);
          this.reply(conn, msg.id);
          break;
        }
        case "settings.get": {
          this.reply(conn, msg.id, store.settings);
          break;
        }
        case "settings.update": {
          const prev = store.settings;
          const modelProvidersChanged =
            JSON.stringify(prev.providers) !== JSON.stringify(msg.settings.providers);
          let nextSettings = msg.settings;
          let modelOptions: ModelOption[] | undefined;
          if (nextSettings.defaultModel) {
            modelOptions = await this.listModelOptions(nextSettings);
            const defaultModel = normalizeModelRefReasoning(
              nextSettings.defaultModel,
              modelOptions,
            );
            if (defaultModel !== nextSettings.defaultModel) {
              nextSettings = { ...nextSettings, defaultModel };
            }
            await this.validateReasoningEffort(defaultModel, nextSettings, modelOptions);
          }
          const providerChanged =
            modelProvidersChanged ||
            JSON.stringify(prev.mcpServers) !== JSON.stringify(nextSettings.mcpServers) ||
            JSON.stringify(prev.disabledSkills) !== JSON.stringify(nextSettings.disabledSkills) ||
            JSON.stringify(prev.skillDirectories) !== JSON.stringify(nextSettings.skillDirectories);
          if (providerChanged) {
            await this.manager.reconfigureOpenSessions();
          }
          store.saveSettings(nextSettings);
          if (modelProvidersChanged) {
            modelOptions ??= await this.listModelOptions(nextSettings);
            if (store.normalizeStoredReasoningEfforts(modelOptions)) this.broadcastShell();
          }
          this.broadcastSettings();
          this.broadcastSkills();
          this.reply(conn, msg.id);
          break;
        }
        case "skills.list": {
          this.reply(conn, msg.id, listSkills());
          break;
        }
        case "skill.save": {
          saveSkill(msg.name, msg.description, msg.content);
          this.broadcastSkills();
          this.reply(conn, msg.id);
          break;
        }
        case "skill.delete": {
          deleteSkill(msg.name);
          this.broadcastSkills();
          this.reply(conn, msg.id);
          break;
        }
        case "models.list": {
          const models = await this.listModelOptions();
          if (store.normalizeStoredReasoningEfforts(models)) {
            this.broadcastSettings();
            this.broadcastShell();
          }
          this.reply(conn, msg.id, models);
          break;
        }
        case "provider.models.discover": {
          const models = await discoverProviderModels(msg.provider);
          this.reply(conn, msg.id, models);
          break;
        }
        case "files.search": {
          const project = store.projects.find((p) => p.id === msg.projectId);
          if (!project) throw new Error("项目不存在");
          this.reply(conn, msg.id, searchFiles(project.path, msg.query));
          break;
        }
        default: {
          this.replyError(conn, (msg as { id?: string }).id ?? "", "未知消息类型");
        }
      }
    } catch (err) {
      this.replyError(conn, msg.id, err);
    }
  }

  async shutdown() {
    await this.manager.shutdown();
  }
}
