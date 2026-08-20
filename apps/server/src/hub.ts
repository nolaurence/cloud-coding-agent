import { browserPool } from "./browser.js";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  AppSettings,
  ClientMessage,
  ConnectorConfig,
  ConnectorStatus,
  ModelOption,
  ModelRef,
  ServerMessage,
  ShellState,
  ThreadAccess,
  ThreadCreateResult,
  ThreadMeta,
  TurnAttachment,
  UserRole,
} from "@cca/protocol";
import { store } from "./store.js";
import { CopilotManager } from "./copilot.js";
import { searchFiles } from "./files.js";
import { deleteSkill, listSkills, saveSkill } from "./skills.js";
import {
  deleteScopedMcpServer,
  listScopedMcpServers,
  normalizeMcpServer,
  saveScopedMcpServer,
} from "./mcpServers.js";
import {
  DEFAULT_MODEL_PROVIDER_ID,
  flattenModels,
  isAgentMode,
  isReasoningEffort,
  normalizeContextWindowTokens,
  normalizeModelRefReasoning,
  resolveThreadModel,
  resolveThreadModelProviderId,
} from "@cca/protocol";
import { verifyToken, type TokenPayload } from "./auth.js";
import { getThreadAccess } from "./threadAccess.js";
import { discoverProviderModels } from "./providers.js";
import {
  listProjectDirectory,
  listProjectFiles,
  projectDiff,
  projectGitPullTarget,
  readProjectFile,
  resolveProjectGitRoot,
  writeProjectFile,
} from "./workspace.js";
import { TerminalManager } from "./terminals.js";
import { bindGitProvider, listGitBindings, unbindGitProvider } from "./gitBindings.js";
import { commitProjectChanges, runAuthenticatedGit } from "./gitOperations.js";
import {
  assertProjectGitVersion,
  projectGitCommitDiff,
  projectGitFileDiff,
  projectGitLog,
  projectGitPushTarget,
  projectGitStagedDiff,
  projectGitStatus,
  stageProjectFiles,
  unstageProjectFiles,
  withProjectGitMutation,
} from "./gitWorkspace.js";
import { ConnectorManager } from "./connectors/manager.js";
import { removeThreadUploads, removeUploadedImages, validateTurnAttachments } from "./uploads.js";
import {
  createThreadShare,
  deleteThreadShare,
  getThreadShare,
  inspectThreadShare,
  redeemThreadShare,
  revokeThreadShare,
  validateThreadShareToken,
} from "./threadShares.js";
import { createUserWorkspace } from "./workspaceProjects.js";

interface ClientConn {
  socket: WebSocket;
  user: TokenPayload;
  shellSubscribed: boolean;
  threadSubs: Map<string, string | null>;
  pendingThreadSubs: Set<string>;
}

export class Hub {
  private clients = new Set<ClientConn>();
  private provisionalThreads = new Map<string, ClientConn | null>();
  private manager = new CopilotManager();
  private connectors = new ConnectorManager(
    this.manager,
    (statuses) => this.broadcastConnectorStatuses(statuses),
    () => this.broadcastShell(),
  );
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
    this.manager.onResourcesChanged(() => {
      this.broadcastSettings();
      this.broadcastSkills();
    });
    void this.connectors.applySettings(store.settings.connectors).catch((error) => {
      console.error("[cca] 连接器启动失败", error);
    });
  }

  // 启动后后台预热插件市场缓存
  warmupPlugins() {
    void this.manager.warmupPlugins();
  }

  handleConnection(socket: WebSocket, token: string | undefined) {
    const user = token ? verifyToken(token) : null;
    if (!user) {
      socket.send(JSON.stringify({ type: "auth.error", message: "未授权,请重新登录" }));
      socket.close(4401, "unauthorized");
      return;
    }
    const conn: ClientConn = {
      socket,
      user,
      shellSubscribed: false,
      threadSubs: new Map(),
      pendingThreadSubs: new Set(),
    };
    this.clients.add(conn);
    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, 30_000);
    heartbeat.unref();
    socket.on("message", (raw) => {
      void this.onMessage(conn, raw.toString()).catch((err) => {
        console.error("message error", err);
      });
    });
    socket.on("error", (error) => {
      console.warn(`[cca] WebSocket error user=${user.username}`, error);
    });
    socket.on("close", (code, rawReason) => {
      clearInterval(heartbeat);
      const runningThreadIds = [...conn.threadSubs.keys()].filter((threadId) =>
        this.manager.isRunning(threadId),
      );
      if (runningThreadIds.length > 0 || (code !== 1000 && code !== 1001)) {
        const reason = rawReason.toString().replace(/\s+/g, " ").trim().slice(0, 160);
        console.warn(
          `[cca] WebSocket closed user=${user.username} code=${code}` +
            ` runningThreads=${runningThreadIds.join(",") || "none"}` +
            (reason ? ` reason=${reason}` : ""),
        );
      }
      for (const threadId of conn.threadSubs.keys()) {
        this.manager.unsubscribe(threadId);
      }
      for (const threadId of conn.pendingThreadSubs) {
        this.manager.unsubscribe(threadId);
      }
      conn.threadSubs.clear();
      conn.pendingThreadSubs.clear();
      this.clients.delete(conn);
    });
  }

  private threadAccess(conn: ClientConn, thread: ThreadMeta | undefined): ThreadAccess | null {
    if (thread && this.provisionalThreads.has(thread.id)) return null;
    return getThreadAccess(conn.user, thread);
  }

  private assertProvisionalOwner(conn: ClientConn, threadId: string) {
    if (
      !this.clients.has(conn) ||
      conn.socket.readyState !== conn.socket.OPEN ||
      !conn.pendingThreadSubs.has(threadId) ||
      this.provisionalThreads.get(threadId) !== conn
    ) {
      throw new Error("连接已断开");
    }
  }

  private initialTurnImageAttachments(value: unknown): TurnAttachment[] | undefined {
    if (!value || typeof value !== "object") return undefined;
    const attachments = (value as { attachments?: unknown }).attachments;
    if (!Array.isArray(attachments)) return undefined;
    return attachments.flatMap((attachment) => {
      if (!attachment || typeof attachment !== "object") return [];
      const imageId = (attachment as { imageId?: unknown }).imageId;
      return typeof imageId === "string" ? [{ path: "", imageId }] : [];
    });
  }

  private cleanupInitialTurnUploads(conn: ClientConn, initialTurn: unknown) {
    removeUploadedImages(conn.user.username, this.initialTurnImageAttachments(initialTurn));
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private withCleanupFailures(error: unknown, failures: readonly string[]): Error {
    const original = this.errorMessage(error);
    if (failures.length === 0) return error instanceof Error ? error : new Error(original);
    return new Error(`${original} (清理失败: ${failures.join("; ")})`, { cause: error });
  }

  private async rollbackInitialThread(
    conn: ClientConn,
    thread: ThreadMeta | undefined,
    initialTurn: unknown,
    creationError: unknown,
  ): Promise<Error> {
    const cleanupFailures: string[] = [];
    const recordFailure = (step: string, error: unknown) => {
      cleanupFailures.push(`${step}: ${this.errorMessage(error)}`);
    };

    if (thread) {
      this.provisionalThreads.set(thread.id, null);
      const hadPendingSubscription = conn.pendingThreadSubs.delete(thread.id);
      const hadActiveSubscription = conn.threadSubs.delete(thread.id);
      if (hadPendingSubscription || hadActiveSubscription) {
        try {
          this.manager.unsubscribe(thread.id);
        } catch (error) {
          recordFailure("取消订阅", error);
        }
      }
    }

    try {
      this.cleanupInitialTurnUploads(conn, initialTurn);
    } catch (error) {
      recordFailure("清理上传", error);
    }

    if (thread) {
      try {
        this.terminals.closeThread(thread.id);
      } catch (error) {
        recordFailure("关闭终端", error);
      }
      try {
        await browserPool.stopThread(thread.id);
      } catch (error) {
        recordFailure("关闭浏览器", error);
      }
      try {
        await this.manager.deleteThread(thread.id);
      } catch (error) {
        recordFailure("删除运行时", error);
      }
      try {
        store.deleteThread(thread.id);
      } catch (error) {
        recordFailure("删除会话元数据", error);
      }
      if (!store.getThread(thread.id)) this.provisionalThreads.delete(thread.id);
      try {
        this.broadcastShell();
      } catch (error) {
        recordFailure("广播会话列表", error);
      }
    }

    return this.withCleanupFailures(creationError, cleanupFailures);
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

  private canReceiveThread(
    conn: ClientConn,
    threadId: string,
    thread: ThreadMeta | undefined,
  ): boolean {
    if (this.canRead(conn, thread)) return true;
    if (this.provisionalThreads.has(threadId)) return false;
    const shareToken = conn.threadSubs.get(threadId);
    return typeof shareToken === "string" && validateThreadShareToken(threadId, shareToken) !== null;
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

  private requireOwnedProject(conn: ClientConn, projectId: string) {
    const project = store.projects.find((candidate) => candidate.id === projectId);
    if (!project || project.ownerId !== conn.user.username) {
      throw new Error("工作区不存在或无权访问");
    }
    return project;
  }

  private requireOwnedThreadProject(conn: ClientConn, threadId: string, projectId: string) {
    const thread = store.getThread(threadId);
    if (!this.canManage(conn, thread)) throw new Error("只有会话所有者可以执行此操作");
    if (thread?.projectId !== projectId) throw new Error("操作与当前会话工作区不匹配");
    return { thread, project: this.requireOwnedProject(conn, projectId) };
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
      projects: store.projects
        .filter((project) => project.ownerId === conn.user.username)
        .map(({ id, name }) => ({ id, name })),
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
      if (conn.threadSubs.has(threadId) && this.canReceiveThread(conn, threadId, thread)) {
        this.send(conn, { type: "thread.event", threadId, event });
      }
    }
  }

  private connectorsFor(username: string): ConnectorConfig[] {
    return store.settings.connectors.filter((connector) => connector.ownerId === username);
  }

  private connectorStatusesFor(username: string, statuses = this.connectors.getStatuses()): ConnectorStatus[] {
    const visibleIds = new Set(this.connectorsFor(username).map((connector) => connector.id));
    return statuses.filter((status) => visibleIds.has(status.id));
  }

  private settingsFor(conn: ClientConn): AppSettings {
    const connectors = this.connectorsFor(conn.user.username);
    if (conn.user.role === "admin") return { ...store.settings, connectors };
    return {
      ...store.settings,
      providers: store.settings.providers.map(({ apiKey: _apiKey, ...provider }) => provider),
      connectors: [],
      mcpServers: [],
      skillDirectories: [],
      disabledSkills: [],
    };
  }

  private broadcastConnectorStatuses(statuses: ConnectorStatus[] = this.connectors.getStatuses()) {
    for (const conn of this.clients) {
      if (conn.shellSubscribed && conn.user.role === "admin") {
        this.send(conn, {
          type: "connectors.status",
          data: this.connectorStatusesFor(conn.user.username, statuses),
        });
      }
    }
  }

  private broadcastSettings() {
    for (const conn of this.clients) {
      if (conn.shellSubscribed) this.send(conn, { type: "settings", data: this.settingsFor(conn) });
    }
  }

  private reconcileThreadClients(threadId: string) {
    const thread = store.getThread(threadId);
    for (const conn of this.clients) {
      if (conn.threadSubs.has(threadId) && !this.canReceiveThread(conn, threadId, thread)) {
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
      for (const threadId of [...conn.threadSubs.keys()]) {
        if (this.canReceiveThread(conn, threadId, store.getThread(threadId))) continue;
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

  private validateModelContextWindows(settings: AppSettings): void {
    for (const provider of settings.providers) {
      for (const model of provider.models) {
        const value: unknown = model.contextWindowTokens;
        if (value !== undefined && normalizeContextWindowTokens(value) === undefined) {
          throw new Error(`${model.name ?? (model.id || "未命名模型")} 的上下文 Token 必须是正整数`);
        }
      }
    }
  }

  private validateModel(model: ModelRef, settings: AppSettings): void {
    if (model.providerId === DEFAULT_MODEL_PROVIDER_ID) return;
    const provider = settings.providers.find((candidate) => candidate.id === model.providerId);
    if (!provider) throw new Error("模型提供方不存在");
    if (!provider.models.some((candidate) => candidate.id === model.modelId)) {
      throw new Error("模型不存在");
    }
  }

  private async validateReasoningEffort(
    model: ModelRef,
    settings: AppSettings = store.settings,
    modelOptions?: readonly ModelOption[],
  ): Promise<void> {
    this.validateModel(model, settings);
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

  private async validateConnectors(
    connectors: ConnectorConfig[],
    settings: AppSettings,
    modelOptions?: readonly ModelOption[],
  ): Promise<ConnectorConfig[]> {
    const ids = new Set<string>();
    const normalized: ConnectorConfig[] = [];
    for (const connector of connectors) {
      const id = connector.id.trim();
      const name = connector.name.trim();
      const appId = connector.appId.trim();
      const appSecret = connector.appSecret.trim();
      const projectId = connector.projectId.trim();
      if (!id || ids.has(id)) throw new Error("连接器标识不能为空或重复");
      ids.add(id);
      if (!name) throw new Error("连接器名称必填");
      if (connector.platform !== "qq" && connector.platform !== "feishu") {
        throw new Error("不支持的连接器平台");
      }
      if (!appId || !appSecret) throw new Error(`${name} 的 App ID（AK）和 App Secret（AS）必填`);
      const ownerId = connector.ownerId?.trim();
      const project = store.projects.find((candidate) => candidate.id === projectId);
      if (!ownerId || !project || project.ownerId !== ownerId) {
        throw new Error(`${name} 关联的工作区与所有者不匹配`);
      }
      const options = modelOptions ?? (await this.listModelOptions(settings));
      const model = normalizeModelRefReasoning(connector.model, options);
      if (!options.some((option) =>
        option.ref.providerId === model.providerId && option.ref.modelId === model.modelId
      )) {
        throw new Error(`${name} 选择的模型不存在`);
      }
      await this.validateReasoningEffort(model, settings, options);
      normalized.push({
        ...connector,
        id,
        name,
        appId,
        appSecret,
        projectId,
        model,
        allowedUserIds: [...new Set(connector.allowedUserIds?.map((value) => value.trim()).filter(Boolean) ?? [])],
        ownerId,
      });
    }
    return normalized;
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
          if (conn.user.role === "admin") {
            this.send(conn, { type: "connectors.status", data: this.connectors.getStatuses() });
          }
          this.reply(conn, msg.id);
          break;
        }
        case "workspace.create": {
          const { id, name } = await createUserWorkspace(conn.user.username, msg.name);
          this.broadcastShell();
          this.reply(conn, msg.id, { id, name });
          break;
        }
        case "workspace.remove": {
          this.requireOwnedProject(conn, msg.projectId);
          if (store.threads.some((thread) => thread.projectId === msg.projectId)) {
            throw new Error("请先删除工作区内的会话");
          }
          if (store.settings.connectors.some((connector) => connector.projectId === msg.projectId)) {
            throw new Error("请先移除使用该工作区的连接器");
          }
          await store.removeProject(msg.projectId);
          this.broadcastShell();
          this.reply(conn, msg.id);
          break;
        }
        case "thread.create": {
          const initialTurnValue: unknown = msg.initialTurn;
          let thread: ThreadMeta | undefined;
          let initialTurnAccepted = false;
          try {
            const project = this.requireOwnedProject(conn, msg.projectId);
            if (msg.agentMode !== undefined && !isAgentMode(msg.agentMode)) {
              throw new Error("会话模式无效");
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

            if (
              initialTurnValue !== undefined &&
              (!initialTurnValue ||
                typeof initialTurnValue !== "object" ||
                typeof (initialTurnValue as { text?: unknown }).text !== "string" ||
                ((initialTurnValue as { attachments?: unknown }).attachments !== undefined &&
                  !Array.isArray((initialTurnValue as { attachments?: unknown }).attachments)))
            ) {
              throw new Error("首条消息格式无效");
            }
            const initialTurn = initialTurnValue as typeof msg.initialTurn;
            if (initialTurn && !initialTurn.text.trim() && !initialTurn.attachments?.length) {
              throw new Error("请输入消息内容");
            }
            if (initialTurn) {
              validateTurnAttachments(conn.user.username, project.path, initialTurn.attachments);
            }

            thread = {
              id: randomUUID(),
              projectId: msg.projectId,
              title: "新会话",
              model,
              modelProviderId: model?.providerId ?? DEFAULT_MODEL_PROVIDER_ID,
              agentMode: msg.agentMode ?? "standard",
              userId: conn.user.username,
              createdAt: Date.now(),
              updatedAt: Date.now(),
              archived: false,
            };
            if (initialTurn) this.provisionalThreads.set(thread.id, conn);
            store.upsertThread(thread);

            if (initialTurn) {
              conn.pendingThreadSubs.add(thread.id);
              await this.manager.subscribe(thread.id, conn.user.username);
              this.assertProvisionalOwner(conn, thread.id);
              await this.manager.sendMessage(
                thread.id,
                initialTurn.text,
                initialTurn.attachments,
                conn.user.username,
                () => this.assertProvisionalOwner(conn, thread!.id),
                () => {
                  initialTurnAccepted = true;
                },
              );
              this.provisionalThreads.delete(thread.id);

              const ownsPendingSubscription = conn.pendingThreadSubs.delete(thread.id);
              if (
                ownsPendingSubscription &&
                this.clients.has(conn) &&
                conn.socket.readyState === conn.socket.OPEN
              ) {
                conn.threadSubs.set(thread.id, null);
                this.send(conn, {
                  type: "thread.event",
                  threadId: thread.id,
                  event: this.manager.snapshot(thread.id),
                });
              } else if (ownsPendingSubscription) {
                this.manager.unsubscribe(thread.id);
              }
            }
          } catch (error) {
            if (thread && initialTurnAccepted) {
              this.provisionalThreads.delete(thread.id);
              const hadPendingSubscription = conn.pendingThreadSubs.delete(thread.id);
              const hadActiveSubscription = conn.threadSubs.delete(thread.id);
              if (hadPendingSubscription || hadActiveSubscription) {
                this.manager.unsubscribe(thread.id);
              }
              console.warn(`[cca] finalize accepted initial turn failed thread=${thread.id}`, error);
              this.broadcastShell();
              if (this.clients.has(conn) && conn.socket.readyState === conn.socket.OPEN) {
                this.send(conn, {
                  type: "thread.event",
                  threadId: thread.id,
                  event: this.manager.snapshot(thread.id),
                });
                this.reply(conn, msg.id, {
                  ...this.threadMeta(conn, store.getThread(thread.id) ?? thread),
                  initialTurnAccepted: true,
                } satisfies ThreadCreateResult);
              }
              break;
            }

            throw await this.rollbackInitialThread(conn, thread, initialTurnValue, error);
          }

          const createdThread = store.getThread(thread!.id) ?? thread!;
          this.broadcastShell();
          const result: ThreadCreateResult = {
            ...this.threadMeta(conn, createdThread),
            ...(initialTurnAccepted ? { initialTurnAccepted: true } : {}),
          };
          this.reply(conn, msg.id, result);
          break;
        }
        case "thread.delete": {
          const thread = store.getThread(msg.threadId);
          if (!this.canManage(conn, thread)) throw new Error("无权管理该会话");
          this.terminals.closeThread(msg.threadId);
          await browserPool.stopThread(msg.threadId);
          await this.manager.deleteThread(msg.threadId);
          if (thread) removeThreadUploads(thread);
          await deleteThreadShare(msg.threadId);
          store.deleteThread(msg.threadId);
          this.reconcileThreadClients(msg.threadId);
          this.reply(conn, msg.id);
          break;
        }
        case "thread.setAgentMode": {
          const thread = store.getThread(msg.threadId);
          if (!thread) throw new Error("会话不存在");
          if (!this.canManage(conn, thread)) throw new Error("无权管理该会话");
          if (!isAgentMode(msg.agentMode)) throw new Error("会话模式无效");
          await this.manager.setThreadAgentMode(msg.threadId, msg.agentMode);
          this.broadcastShell();
          this.reply(conn, msg.id);
          break;
        }
        case "thread.setModel": {
          const thread = store.getThread(msg.threadId);
          if (!thread) throw new Error("会话不存在");
          if (!this.canManage(conn, thread)) throw new Error("无权管理该会话");
          const modelProviderId = resolveThreadModelProviderId(
            thread,
            store.settings.defaultModel,
          );
          if (msg.model.providerId !== modelProviderId) {
            throw new Error("会话创建后不支持切换模型提供方,请新建会话使用该模型");
          }
          await this.validateReasoningEffort(msg.model);
          const currentModel = resolveThreadModel(thread, store.settings.defaultModel);
          await this.manager.setThreadModel(msg.threadId, currentModel, msg.model);
          const modelChanged = currentModel?.modelId !== msg.model.modelId;
          store.upsertThread({
            ...thread,
            model: msg.model,
            modelProviderId,
            contextUsage: modelChanged ? undefined : thread.contextUsage,
          });
          this.broadcastShell();
          this.reply(conn, msg.id);
          break;
        }
        case "thread.subscribe": {
          if (!this.canRead(conn, store.getThread(msg.threadId))) throw new Error("无权访问该会话");
          if (conn.threadSubs.has(msg.threadId)) {
            conn.threadSubs.set(msg.threadId, null);
            this.reply(conn, msg.id);
            break;
          }
          const snapshot = await this.manager.subscribe(msg.threadId, conn.user.username);
          if (!this.canRead(conn, store.getThread(msg.threadId))) {
            this.manager.unsubscribe(msg.threadId);
            throw new Error("无权访问该会话");
          }
          conn.threadSubs.set(msg.threadId, null);
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
        case "thread.share.preview": {
          const inspected = inspectThreadShare(msg.token);
          if (!inspected) throw new Error("分享链接无效或已失效");
          const thread = store.getThread(inspected.threadId);
          if (!thread || this.provisionalThreads.has(thread.id)) {
            throw new Error("分享的会话不存在");
          }
          const hadSubscription = conn.threadSubs.has(thread.id);
          const previousSubscription = conn.threadSubs.get(thread.id);
          const snapshot = await this.manager.subscribe(thread.id, thread.userId);
          if (validateThreadShareToken(thread.id, msg.token) === null) {
            this.manager.unsubscribe(thread.id);
            throw new Error("分享链接无效或已失效");
          }
          if (hadSubscription) {
            this.manager.unsubscribe(thread.id);
            if (previousSubscription !== null) conn.threadSubs.set(thread.id, msg.token.trim());
          } else {
            conn.threadSubs.set(thread.id, msg.token.trim());
          }
          this.send(conn, { type: "thread.event", threadId: thread.id, event: snapshot });
          this.reply(conn, msg.id, {
            thread: { ...thread, access: "readonly", shared: true },
            mode: inspected.mode,
          });
          break;
        }
        case "thread.share.redeem": {
          const redeemed = await redeemThreadShare(msg.token, conn.user.username);
          const thread = store.getThread(redeemed.threadId);
          if (!thread || this.provisionalThreads.has(thread.id)) {
            if (!thread) await revokeThreadShare(redeemed.threadId);
            throw new Error("分享的会话不存在");
          }
          if (conn.threadSubs.has(thread.id)) conn.threadSubs.set(thread.id, null);
          if (conn.shellSubscribed) this.send(conn, { type: "shell", data: this.shellState(conn) });
          this.reply(conn, msg.id, this.threadMeta(conn, thread));
          break;
        }
        case "turn.start": {
          if (!this.canInteract(conn, store.getThread(msg.threadId))) throw new Error("当前分享仅允许查看");
          const thread = store.getThread(msg.threadId);
          if (!thread) throw new Error("会话不存在");
          const project = store.projects.find((candidate) => candidate.id === thread.projectId);
          if (!project || project.ownerId !== thread.userId) {
            throw new Error("会话关联的工作区无效");
          }
          validateTurnAttachments(conn.user.username, project.path, msg.attachments);
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
        case "thread.compact": {
          if (!this.canInteract(conn, store.getThread(msg.threadId))) throw new Error("当前分享仅允许查看");
          const result = await this.manager.compactContext(msg.threadId, conn.user.username);
          this.reply(conn, msg.id, result);
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
          const mcpIds = new Set<string>();
          const mcpServers = msg.settings.mcpServers.map((server) => {
            const normalized = normalizeMcpServer(server);
            if (mcpIds.has(normalized.id)) throw new Error("MCP 服务器标识不能重复");
            mcpIds.add(normalized.id);
            return normalized;
          });
          let nextSettings = { ...msg.settings, mcpServers };
          this.validateModelContextWindows(nextSettings);
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
          modelOptions ??= await this.listModelOptions(nextSettings);
          const otherConnectors = prev.connectors.filter(
            (connector) => connector.ownerId !== conn.user.username,
          );
          const reservedConnectorIds = new Set(otherConnectors.map((connector) => connector.id));
          if (nextSettings.connectors.some((connector) => reservedConnectorIds.has(connector.id.trim()))) {
            throw new Error("连接器标识已被其他用户使用");
          }
          const connectors = await this.validateConnectors(
            nextSettings.connectors.map((connector) => ({
              ...connector,
              appSecret: connector.appSecret ||
                prev.connectors.find(
                  (candidate) =>
                    candidate.id === connector.id && candidate.ownerId === conn.user.username,
                )?.appSecret || "",
              ownerId: conn.user.username,
            })),
            nextSettings,
            modelOptions,
          );
          nextSettings = { ...nextSettings, connectors: [...otherConnectors, ...connectors] };
          const providerChanged =
            modelProvidersChanged ||
            JSON.stringify(prev.mcpServers) !== JSON.stringify(nextSettings.mcpServers) ||
            JSON.stringify(prev.disabledSkills) !== JSON.stringify(nextSettings.disabledSkills) ||
            JSON.stringify(prev.skillDirectories) !== JSON.stringify(nextSettings.skillDirectories);
          if (providerChanged) {
            await this.manager.reconfigureOpenSessions(nextSettings, prev);
          }
          store.saveSettings(nextSettings);
          await this.connectors.applySettings(nextSettings.connectors);
          if (modelProvidersChanged) {
            modelOptions ??= await this.listModelOptions(nextSettings);
            store.normalizeStoredReasoningEfforts(modelOptions);
            this.broadcastShell();
          }
          this.broadcastSettings();
          this.broadcastSkills();
          this.reply(conn, msg.id);
          break;
        }
        case "connectors.status": {
          this.requireAdmin(conn);
          this.reply(
            conn,
            msg.id,
            this.connectorStatusesFor(conn.user.username),
          );
          break;
        }
        case "mcp.list": {
          this.requireAdmin(conn);
          this.reply(conn, msg.id, listScopedMcpServers("platform"));
          break;
        }
        case "mcp.save": {
          this.requireAdmin(conn);
          if (this.manager.runningThreadIds().length > 0) {
            throw new Error("当前仍有任务运行,请停止或等待完成后再修改 MCP 配置");
          }
          const prev = store.settings;
          const saved = saveScopedMcpServer("platform", msg.server);
          await this.manager.reconfigureOpenSessions(store.settings, prev);
          this.broadcastSettings();
          this.reply(conn, msg.id, saved);
          break;
        }
        case "mcp.delete": {
          this.requireAdmin(conn);
          if (this.manager.runningThreadIds().length > 0) {
            throw new Error("当前仍有任务运行,请停止或等待完成后再修改 MCP 配置");
          }
          const prev = store.settings;
          deleteScopedMcpServer("platform", msg.idToDelete);
          await this.manager.reconfigureOpenSessions(store.settings, prev);
          this.broadcastSettings();
          this.reply(conn, msg.id);
          break;
        }
        case "skills.list": {
          this.reply(conn, msg.id, listSkills());
          break;
        }
        case "skill.save": {
          this.requireAdmin(conn);
          if (this.manager.runningThreadIds().length > 0) {
            throw new Error("当前仍有任务运行,请停止或等待完成后再修改技能配置");
          }
          const prev = store.settings;
          saveSkill(msg.name, msg.description, msg.content);
          await this.manager.reconfigureOpenSessions(store.settings, prev);
          this.broadcastSkills();
          this.reply(conn, msg.id);
          break;
        }
        case "skill.delete": {
          this.requireAdmin(conn);
          if (this.manager.runningThreadIds().length > 0) {
            throw new Error("当前仍有任务运行,请停止或等待完成后再修改技能配置");
          }
          const prev = store.settings;
          deleteSkill(msg.name);
          await this.manager.reconfigureOpenSessions(store.settings, prev);
          this.broadcastSkills();
          this.reply(conn, msg.id);
          break;
        }
        case "plugins.marketplaces.list": {
          this.requireAdmin(conn);
          this.reply(conn, msg.id, await this.manager.listPluginMarketplaces());
          break;
        }
        case "plugins.marketplace.add": {
          this.requireAdmin(conn);
          this.reply(conn, msg.id, await this.manager.addPluginMarketplace(msg.source));
          break;
        }
        case "plugins.marketplace.remove": {
          this.requireAdmin(conn);
          this.reply(
            conn,
            msg.id,
            await this.manager.removePluginMarketplace(msg.name, msg.force ?? false),
          );
          break;
        }
        case "plugins.marketplace.browse": {
          this.requireAdmin(conn);
          this.reply(conn, msg.id, await this.manager.browsePluginMarketplace(msg.name));
          break;
        }
        case "plugins.list": {
          this.requireAdmin(conn);
          this.reply(conn, msg.id, await this.manager.listInstalledPlugins());
          break;
        }
        case "plugins.install": {
          this.requireAdmin(conn);
          this.reply(conn, msg.id, await this.manager.installPlugin(msg.source));
          break;
        }
        case "plugins.uninstall": {
          this.requireAdmin(conn);
          await this.manager.uninstallPlugin(msg.name, msg.directSourceId);
          this.reply(conn, msg.id);
          break;
        }
        case "plugins.setEnabled": {
          this.requireAdmin(conn);
          await this.manager.setPluginEnabled(msg.name, msg.enabled);
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
          const project = this.requireOwnedProject(conn, msg.projectId);
          this.reply(conn, msg.id, searchFiles(project.path, msg.query));
          break;
        }
        case "project.files": {
          const project = this.requireOwnedProject(conn, msg.projectId);
          this.reply(conn, msg.id, listProjectFiles(project.path));
          break;
        }
        case "project.directory.list": {
          const project = this.requireOwnedProject(conn, msg.projectId);
          this.reply(conn, msg.id, listProjectDirectory(project.path, msg.path));
          break;
        }
        case "project.file.read": {
          const project = this.requireOwnedProject(conn, msg.projectId);
          this.reply(conn, msg.id, readProjectFile(project.path, msg.path));
          break;
        }
        case "project.file.write": {
          const { project } = this.requireOwnedThreadProject(conn, msg.threadId, msg.projectId);
          this.reply(
            conn,
            msg.id,
            writeProjectFile(project.path, msg.path, msg.content, msg.expectedVersion),
          );
          break;
        }
        case "project.diff": {
          const project = this.requireOwnedProject(conn, msg.projectId);
          this.reply(conn, msg.id, await projectDiff(project.path));
          break;
        }
        case "project.git.status": {
          const project = this.requireOwnedProject(conn, msg.projectId);
          const gitRoot = resolveProjectGitRoot(project.path, msg.directory);
          this.reply(conn, msg.id, await projectGitStatus(gitRoot));
          break;
        }
        case "project.git.log": {
          const project = this.requireOwnedProject(conn, msg.projectId);
          const gitRoot = resolveProjectGitRoot(project.path, msg.directory);
          this.reply(conn, msg.id, await projectGitLog(gitRoot, { limit: msg.limit, query: msg.query }));
          break;
        }
        case "project.git.commitDiff": {
          const project = this.requireOwnedProject(conn, msg.projectId);
          const gitRoot = resolveProjectGitRoot(project.path, msg.directory);
          this.reply(conn, msg.id, await projectGitCommitDiff(gitRoot, msg.hash));
          break;
        }
        case "project.git.fileDiff": {
          const project = this.requireOwnedProject(conn, msg.projectId);
          const gitRoot = resolveProjectGitRoot(project.path, msg.directory);
          this.reply(conn, msg.id, await projectGitFileDiff(gitRoot, msg.path, msg.staged));
          break;
        }
        case "project.git.generateCommitMessage": {
          const { project } = this.requireOwnedThreadProject(conn, msg.threadId, msg.projectId);
          const gitRoot = resolveProjectGitRoot(project.path, msg.directory);
          await assertProjectGitVersion(gitRoot, {
            expectedHead: msg.expectedHead,
            expectedIndexTree: msg.expectedIndexTree,
          });
          const diff = await projectGitStagedDiff(gitRoot);
          const message = await this.manager.generateCommitMessage(
            msg.threadId,
            conn.user.username,
            diff.patch,
            diff.truncated,
          );
          await assertProjectGitVersion(gitRoot, {
            expectedHead: msg.expectedHead,
            expectedIndexTree: msg.expectedIndexTree,
          });
          this.reply(conn, msg.id, { message, truncated: diff.truncated });
          break;
        }
        case "project.git.stage": {
          const { project } = this.requireOwnedThreadProject(conn, msg.threadId, msg.projectId);
          const gitRoot = resolveProjectGitRoot(project.path, msg.directory);
          await stageProjectFiles(gitRoot, msg.paths, {
            expectedHead: msg.expectedHead,
            expectedIndexTree: msg.expectedIndexTree,
          });
          this.reply(conn, msg.id);
          break;
        }
        case "project.git.unstage": {
          const { project } = this.requireOwnedThreadProject(conn, msg.threadId, msg.projectId);
          const gitRoot = resolveProjectGitRoot(project.path, msg.directory);
          await unstageProjectFiles(gitRoot, msg.paths, {
            expectedHead: msg.expectedHead,
            expectedIndexTree: msg.expectedIndexTree,
          });
          this.reply(conn, msg.id);
          break;
        }
        case "project.git.pull": {
          const { project } = this.requireOwnedThreadProject(conn, msg.threadId, msg.projectId);
          const gitRoot = resolveProjectGitRoot(project.path, msg.directory);
          this.reply(
            conn,
            msg.id,
            await withProjectGitMutation(gitRoot, async () => {
              const target = await projectGitPullTarget(gitRoot);
              return runAuthenticatedGit(conn.user.username, gitRoot, {
                action: "pull",
                remote: target.remote,
                branch: target.branch,
                strategy: "ff-only",
              });
            }),
          );
          break;
        }
        case "project.git.push": {
          const { project } = this.requireOwnedThreadProject(conn, msg.threadId, msg.projectId);
          const gitRoot = resolveProjectGitRoot(project.path, msg.directory);
          this.reply(
            conn,
            msg.id,
            await withProjectGitMutation(gitRoot, async () => {
              const target = await projectGitPushTarget(gitRoot);
              return runAuthenticatedGit(conn.user.username, gitRoot, {
                action: "push",
                remote: target.remote,
                branch: target.branch,
                setUpstream: target.setUpstream,
              });
            }),
          );
          break;
        }
        case "project.git.commit": {
          const { project } = this.requireOwnedThreadProject(conn, msg.threadId, msg.projectId);
          const gitRoot = resolveProjectGitRoot(project.path, msg.directory);
          this.reply(
            conn,
            msg.id,
            await withProjectGitMutation(gitRoot, async () => {
              if (msg.expectedHead !== undefined || msg.expectedIndexTree !== undefined) {
                if (msg.expectedHead === undefined || msg.expectedIndexTree === undefined) {
                  throw new Error("Git 工作区版本不完整");
                }
                await assertProjectGitVersion(gitRoot, {
                  expectedHead: msg.expectedHead,
                  expectedIndexTree: msg.expectedIndexTree,
                });
              }
              return commitProjectChanges(gitRoot, msg.message, { stageAll: msg.stageAll });
            }),
          );
          break;
        }
        case "terminal.open": {
          const thread = store.getThread(msg.threadId);
          if (!this.canManage(conn, thread)) throw new Error("只有会话所有者可以使用终端");
          const project = store.projects.find((candidate) => candidate.id === thread?.projectId);
          if (!project || project.ownerId !== conn.user.username) {
            throw new Error("工作区不存在或无权访问");
          }
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
    await this.connectors.shutdown();
    await this.manager.shutdown();
  }
}
