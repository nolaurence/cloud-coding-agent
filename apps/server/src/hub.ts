import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  AppSettings,
  ClientMessage,
  ModelOption,
  ModelRef,
  ServerMessage,
  ShellState,
  ThreadAccess,
  ThreadMeta,
  UserRole,
} from "@cca/protocol";
import { store } from "./store.js";
import { CopilotManager } from "./copilot.js";
import { searchFiles } from "./files.js";
import { browseDirectories, resolveProjectDirectory } from "./directories.js";
import { deleteSkill, listSkills, saveSkill } from "./skills.js";
import { flattenModels, isReasoningEffort, normalizeModelRefReasoning } from "@cca/protocol";
import { verifyToken, type TokenPayload } from "./auth.js";
import { discoverProviderModels } from "./providers.js";
import {
  listProjectDirectory,
  listProjectFiles,
  projectDiff,
  readProjectFile,
  writeProjectFile,
} from "./workspace.js";
import { TerminalManager } from "./terminals.js";
import { bindGitProvider, listGitBindings, unbindGitProvider } from "./gitBindings.js";
import { removeThreadUploads, removeUploadedImages, validateOwnedUploads } from "./uploads.js";
import {
  createThreadShare,
  deleteThreadShare,
  getSharedThreadAccess,
  getThreadShare,
  redeemThreadShare,
  revokeThreadShare,
} from "./threadShares.js";

interface ClientConn {
  socket: WebSocket;
  user: TokenPayload;
  shellSubscribed: boolean;
  threadSubs: Set<string>;
}

export class Hub {
  private clients = new Set<ClientConn>();
  private manager = new CopilotManager();
  private terminals = new TerminalManager((ownerId, event) => {
    for (const conn of this.clients) {
      if (conn.user.username === ownerId) this.send(conn, { type: "terminal.event", event });
    }
  });

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

  private threadAccess(conn: ClientConn, thread: ThreadMeta | undefined): ThreadAccess | null {
    if (!thread) return null;
    if (conn.user.role === "admin" || thread.userId === conn.user.username) return "owner";
    if (!thread.userId) return "collaborate";
    return getSharedThreadAccess(thread.id, conn.user.username);
  }

  private canRead(conn: ClientConn, thread: ThreadMeta | undefined): boolean {
    return this.threadAccess(conn, thread) !== null;
  }

  private canInteract(conn: ClientConn, thread: ThreadMeta | undefined): boolean {
    const access = this.threadAccess(conn, thread);
    return access === "owner" || access === "collaborate";
  }

  private canManage(conn: ClientConn, thread: ThreadMeta | undefined): boolean {
    return this.threadAccess(conn, thread) === "owner";
  }

  private threadMeta(conn: ClientConn, thread: ThreadMeta): ThreadMeta {
    return {
      ...thread,
      access: this.threadAccess(conn, thread) ?? undefined,
      shared: getThreadShare(thread.id).active,
    };
  }

  private requireAdmin(conn: ClientConn) {
    if (conn.user.role !== "admin") throw new Error("仅管理员可以执行此操作");
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
    const visibleThreads = [...store.threads]
      .filter((thread) => this.canRead(conn, thread))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const visibleIds = new Set(visibleThreads.map((thread) => thread.id));
    return {
      projects: store.projects,
      threads: visibleThreads.map((thread) => this.threadMeta(conn, thread)),
      runningThreadIds: this.manager.runningThreadIds().filter((threadId) => visibleIds.has(threadId)),
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
      if (conn.threadSubs.has(threadId) && this.canRead(conn, thread)) {
        this.send(conn, { type: "thread.event", threadId, event });
      }
    }
  }

  private settingsFor(conn: ClientConn): AppSettings {
    if (conn.user.role === "admin") return store.settings;
    return {
      ...store.settings,
      providers: store.settings.providers.map(({ apiKey: _apiKey, ...provider }) => provider),
      mcpServers: [],
      skillDirectories: [],
      disabledSkills: [],
    };
  }

  private broadcastSettings() {
    for (const conn of this.clients) {
      if (conn.shellSubscribed) this.send(conn, { type: "settings", data: this.settingsFor(conn) });
    }
  }

  private reconcileThreadClients(threadId: string) {
    const thread = store.getThread(threadId);
    for (const conn of this.clients) {
      if (conn.threadSubs.has(threadId) && !this.canRead(conn, thread)) {
        conn.threadSubs.delete(threadId);
        this.manager.unsubscribe(threadId);
      }
      if (conn.shellSubscribed) this.send(conn, { type: "shell", data: this.shellState(conn) });
    }
  }

  updateUserRole(username: string, role: UserRole) {
    for (const conn of this.clients) {
      if (conn.user.username !== username) continue;
      conn.user = { ...conn.user, role };
      for (const threadId of [...conn.threadSubs]) {
        if (this.canRead(conn, store.getThread(threadId))) continue;
        conn.threadSubs.delete(threadId);
        this.manager.unsubscribe(threadId);
      }
      for (const thread of store.threads) {
        if (!this.canManage(conn, thread)) {
          this.terminals.closeOwnerThread(username, thread.id);
        }
      }
      this.send(conn, { type: "auth.user", user: { username, role } });
      if (conn.shellSubscribed) {
        this.send(conn, { type: "shell", data: this.shellState(conn) });
        this.send(conn, { type: "settings", data: this.settingsFor(conn) });
      }
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
          this.send(conn, { type: "settings", data: this.settingsFor(conn) });
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
          this.reply(conn, msg.id, this.threadMeta(conn, thread));
          break;
        }
        case "thread.delete": {
          const thread = store.getThread(msg.threadId);
          if (!this.canManage(conn, thread)) throw new Error("无权管理该会话");
          this.terminals.closeThread(msg.threadId);
          await this.manager.deleteThread(msg.threadId);
          if (thread) removeThreadUploads(thread);
          await deleteThreadShare(msg.threadId);
          store.deleteThread(msg.threadId);
          this.broadcastShell();
          this.reply(conn, msg.id);
          break;
        }
        case "thread.setModel": {
          const thread = store.getThread(msg.threadId);
          if (!thread) throw new Error("会话不存在");
          if (!this.canManage(conn, thread)) throw new Error("无权管理该会话");
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
          if (!this.canRead(conn, store.getThread(msg.threadId))) throw new Error("无权访问该会话");
          if (conn.threadSubs.has(msg.threadId)) {
            this.reply(conn, msg.id);
            break;
          }
          const snapshot = await this.manager.subscribe(msg.threadId, conn.user.username);
          if (!this.canRead(conn, store.getThread(msg.threadId))) {
            this.manager.unsubscribe(msg.threadId);
            throw new Error("无权访问该会话");
          }
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
        case "thread.share.get": {
          const thread = store.getThread(msg.threadId);
          if (!this.canManage(conn, thread)) throw new Error("无权管理该会话的分享");
          this.reply(conn, msg.id, getThreadShare(msg.threadId));
          break;
        }
        case "thread.share.create": {
          const thread = store.getThread(msg.threadId);
          if (!this.canManage(conn, thread)) throw new Error("无权管理该会话的分享");
          if (msg.mode !== "readonly" && msg.mode !== "collaborate") {
            throw new Error("分享权限无效");
          }
          const share = await createThreadShare(msg.threadId, msg.mode, conn.user.username);
          this.reconcileThreadClients(msg.threadId);
          this.reply(conn, msg.id, share);
          break;
        }
        case "thread.share.revoke": {
          const thread = store.getThread(msg.threadId);
          if (!this.canManage(conn, thread)) throw new Error("无权管理该会话的分享");
          await revokeThreadShare(msg.threadId);
          this.reconcileThreadClients(msg.threadId);
          this.reply(conn, msg.id);
          break;
        }
        case "thread.share.redeem": {
          const redeemed = await redeemThreadShare(msg.token, conn.user.username);
          const thread = store.getThread(redeemed.threadId);
          if (!thread) {
            await revokeThreadShare(redeemed.threadId);
            throw new Error("分享的会话不存在");
          }
          if (conn.shellSubscribed) this.send(conn, { type: "shell", data: this.shellState(conn) });
          this.reply(conn, msg.id, this.threadMeta(conn, thread));
          break;
        }
        case "turn.start": {
          if (!this.canInteract(conn, store.getThread(msg.threadId))) throw new Error("当前分享仅允许查看");
          validateOwnedUploads(conn.user.username, msg.attachments);
          try {
            await this.manager.sendMessage(msg.threadId, msg.text, msg.attachments, conn.user.username);
          } catch (error) {
            removeUploadedImages(conn.user.username, msg.attachments);
            throw error;
          }
          this.broadcastShell();
          this.reply(conn, msg.id);
          break;
        }
        case "turn.interrupt": {
          if (!this.canInteract(conn, store.getThread(msg.threadId))) throw new Error("当前分享仅允许查看");
          await this.manager.interrupt(msg.threadId);
          this.reply(conn, msg.id);
          break;
        }
        case "settings.get": {
          this.reply(conn, msg.id, this.settingsFor(conn));
          break;
        }
        case "settings.update": {
          this.requireAdmin(conn);
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
          this.requireAdmin(conn);
          saveSkill(msg.name, msg.description, msg.content);
          this.broadcastSkills();
          this.reply(conn, msg.id);
          break;
        }
        case "skill.delete": {
          this.requireAdmin(conn);
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
          this.requireAdmin(conn);
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
        case "project.files": {
          const project = store.projects.find((candidate) => candidate.id === msg.projectId);
          if (!project) throw new Error("项目不存在");
          this.reply(conn, msg.id, listProjectFiles(project.path));
          break;
        }
        case "project.directory.list": {
          const project = store.projects.find((candidate) => candidate.id === msg.projectId);
          if (!project) throw new Error("项目不存在");
          this.reply(conn, msg.id, listProjectDirectory(project.path, msg.path));
          break;
        }
        case "project.file.read": {
          const project = store.projects.find((candidate) => candidate.id === msg.projectId);
          if (!project) throw new Error("项目不存在");
          this.reply(conn, msg.id, readProjectFile(project.path, msg.path));
          break;
        }
        case "project.file.write": {
          const thread = store.getThread(msg.threadId);
          if (!this.canManage(conn, thread)) throw new Error("只有会话所有者可以直接编辑文件");
          if (thread?.projectId !== msg.projectId) throw new Error("文件与当前会话项目不匹配");
          const project = store.projects.find((candidate) => candidate.id === msg.projectId);
          if (!project) throw new Error("项目不存在");
          this.reply(
            conn,
            msg.id,
            writeProjectFile(project.path, msg.path, msg.content, msg.expectedVersion),
          );
          break;
        }
        case "project.diff": {
          const project = store.projects.find((candidate) => candidate.id === msg.projectId);
          if (!project) throw new Error("项目不存在");
          this.reply(conn, msg.id, await projectDiff(project.path));
          break;
        }
        case "terminal.open": {
          const thread = store.getThread(msg.threadId);
          if (!this.canManage(conn, thread)) throw new Error("只有会话所有者可以使用终端");
          const project = store.projects.find((candidate) => candidate.id === thread?.projectId);
          if (!project) throw new Error("项目不存在");
          this.reply(
            conn,
            msg.id,
            this.terminals.open(
              conn.user.username,
              msg.threadId,
              msg.terminalId,
              project.path,
              msg.cols,
              msg.rows,
            ),
          );
          break;
        }
        case "terminal.write": {
          this.terminals.write(conn.user.username, msg.terminalId, msg.data);
          this.reply(conn, msg.id);
          break;
        }
        case "terminal.resize": {
          this.terminals.resize(conn.user.username, msg.terminalId, msg.cols, msg.rows);
          this.reply(conn, msg.id);
          break;
        }
        case "terminal.close": {
          this.terminals.close(conn.user.username, msg.terminalId);
          this.reply(conn, msg.id);
          break;
        }
        case "git.bindings": {
          this.reply(conn, msg.id, listGitBindings(conn.user.username));
          break;
        }
        case "git.bind": {
          this.reply(conn, msg.id, await bindGitProvider(conn.user.username, msg.provider, msg.token));
          break;
        }
        case "git.unbind": {
          unbindGitProvider(conn.user.username, msg.provider);
          this.reply(conn, msg.id);
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
    this.terminals.shutdown();
    await this.manager.shutdown();
  }
}
