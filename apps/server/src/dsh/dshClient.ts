// DeepSeek Harness 执行核心：AgentClient/AgentSession 的 DSH 实现。
//
// 架构：每个会话（线程）拥有一个 `dsh --profile sdk` 运行时子进程（stdio JSON-RPC，
// 由 @deepseek-ai/dsh-sdk-client 驱动）。SDK 协议只暴露 initialize / session/prompt /
// session/resume / shutdown 与 session.event / session.status / subagent.* 通知，因此：
//   - 模型路由（BYOK）、MCP、技能、沙箱在 spawn 前写入会话专属的 $DSH_HOME 与 --patch；
//   - 取消（abort）协议没有在途取消，只能回收运行时子进程，会话日志保留、下次拉起续跑；
//   - 会话事件由 DshEventMapper 投影为应用 SessionEvent 契约，再走与 Codex 相同的
//     内存 + JSONL 写前日志 + ThreadEventStore 持久化路径。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HarnessClient, type NotificationSubscription } from "@deepseek-ai/dsh-sdk-client";
import { attachmentReferenceText } from "../attachmentPrompt.js";
import type {
  MessageOptions,
  ModelCapabilitiesOverride,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from "@github/copilot-sdk";
import {
  flattenModels,
  isReasoningEffort,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  type ReasoningEffort,
  type RuntimeStats,
} from "@cca/protocol";
import type { AgentClient, AgentModelInfo, AgentSession } from "../agentRuntime.js";
import { usingDatabase } from "../db.js";
import { COPILOT_HOME, DATA_DIR } from "../env.js";
import { store } from "../store.js";
import { ThreadEventStore, deleteThreadEvents } from "../threadEvents.js";
import { object, array, startLlmGateway, text } from "../llmGateway.js";
import { sanitizedDshRuntimeEnv } from "../runtimeEnv.js";
import { DshEventMapper } from "./dshEvents.js";
import {
  applyDshStatsEvent,
  dshRuntimeStats,
  normalizeDshStats,
  type DshStatsState,
} from "./dshStats.js";
import type { DshSessionEvent } from "./dshWire.js";
import {
  credentialEnvName,
  dshBinPath,
  prepareDshHome,
  sandboxModeFor,
  type DshMcpRow,
  type DshProviderRoute,
} from "./dshConfig.js";

export const DSH_HOME_ROOT = path.join(DATA_DIR, "dsh-home");
/** SDK initialize 的固定路由 id：一个运行时只挂本会话的模型路由。 */
const ROUTE_ID = "cca-primary";

type Config = (SessionConfig | ResumeSessionConfig) & {
  legacySession?: boolean;
  agentMode?: "standard" | "ultra";
  deniedPaths?: string[];
  imageGenerationProvider?: unknown;
  imageGenerationModel?: string;
  imageGenerationOwnerId?: string;
  permissionMode?: PermissionMode;
  onCodexPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;
  runtimeStats?: RuntimeStats;
};

type SetModelOptions = Parameters<AgentSession["setModel"]>[1];

function sessionPath(id: string): string {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new Error("Invalid session id");
  return path.join(DSH_HOME_ROOT, id);
}

function mappingPath(home: string): string {
  return path.join(home, "cca-thread.json");
}

function journalPath(home: string): string {
  return path.join(home, "cca-events.jsonl");
}

function readEvents(file: string): SessionEvent[] {
  if (!fs.existsSync(file)) return [];
  const events: SessionEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const parsed = object(JSON.parse(line));
      text(parsed.type);
      text(parsed.id);
      text(parsed.timestamp);
      object(parsed.data);
      events.push(parsed as unknown as SessionEvent);
    } catch {
      // 追加写入被中断时日志末行可能只有半条记录，跳过它而不是让整个会话无法打开
      console.error("[cca] skipped a corrupted DSH event journal line", file);
    }
  }
  return events;
}

function contextWindowOf(config: Config): number | undefined {
  const value = (config.modelCapabilities as ModelCapabilitiesOverride | undefined)?.limits
    ?.max_context_window_tokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** DSH 的持久化会话位于 <DSH_HOME>/sessions/<workspace-slug>/<sessionId>/。 */
function hasDshSession(home: string, sessionId: string): boolean {
  const root = path.join(home, "sessions");
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .some(
        (entry) =>
          entry.isDirectory() && fs.existsSync(path.join(root, entry.name, sessionId)),
      );
  } catch {
    return false;
  }
}

function mcpServerName(raw: string, used: Set<string>): string {
  const base = (raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32) || "mcp");
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    const suffix = `_${index++}`;
    candidate = base.slice(0, 32 - suffix.length) + suffix;
  }
  used.add(candidate);
  return candidate;
}

interface IdleWaiter {
  resolve(): void;
  reject(error: Error): void;
}

export class DshSession implements AgentSession {
  private listeners = new Set<(event: SessionEvent) => void>();
  private events: SessionEvent[] = [];
  private readonly eventStore: ThreadEventStore;
  private readonly home: string;
  private readonly cwd: string;
  private model: string | undefined;
  private effort: string | undefined;
  private readonly config: Config;
  private readonly release: () => void;
  private readonly mapper: DshEventMapper;
  private runtime: HarnessClient | undefined;
  private pumpTask: Promise<void> | undefined;
  private closing = false;
  private closed = false;
  private disposing = false;
  private sessionExisted = false;
  private hasPrompted = false;
  private aborted = false;
  private waiters = new Set<IdleWaiter>();
  private stats: DshStatsState;
  private statsListeners = new Set<(stats: RuntimeStats) => void>();

  constructor(readonly sessionId: string, config: Config, release: () => void) {
    this.config = config;
    this.release = release;
    this.home = sessionPath(sessionId);
    this.cwd = fs.realpathSync(config.workingDirectory ?? process.cwd());
    for (const directory of [DATA_DIR, ...(config.deniedPaths ?? [])]) {
      const denied = fs.existsSync(directory) ? fs.realpathSync(directory) : path.resolve(directory);
      const relative = path.relative(this.cwd, denied);
      if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) {
        throw new Error("工作区包含服务数据或其他受保护工作区，请使用不重叠的项目目录");
      }
    }
    this.model = config.model;
    this.effort = config.reasoningEffort;
    this.mapper = new DshEventMapper({
      rootSessionId: sessionId,
      contextWindowTokens: contextWindowOf(config),
    });
    this.stats = normalizeDshStats(config.runtimeStats);
    this.eventStore = new ThreadEventStore(sessionId, () => {
      this.dispatch({
        type: "session.error",
        data: {
          errorType: "storage",
          message: "会话历史写入数据库失败，已保留本地日志；请恢复数据库后重新打开会话",
        },
      } as SessionEvent);
    });
  }

  get runtimeDisconnected() {
    return this.closed;
  }

  on(handler: (event: SessionEvent) => void) {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  /** 订阅 DSH 累计统计（轮/步、token、缓存命中、解码速度）。 */
  onRuntimeStats(handler: (stats: RuntimeStats) => void) {
    this.statsListeners.add(handler);
    return () => {
      this.statsListeners.delete(handler);
    };
  }
  async getEvents() {
    return usingDatabase() ? this.eventStore.read() : [...this.events];
  }

  async open(resume: boolean) {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(this.home, "profiles"), { recursive: true, mode: 0o700 });
    const stored = usingDatabase() ? await this.eventStore.read() : [];
    const mapping = mappingPath(this.home);
    if (resume) {
      if (!fs.existsSync(mapping)) {
        throw new Error("Harness 会话映射缺失；请恢复会话备份，而不是重新创建");
      }
      if (usingDatabase() && stored.length && !fs.existsSync(journalPath(this.home))) {
        throw new Error("Harness 本地事件日志缺失；请先恢复会话备份再继续");
      }
      const value = object(JSON.parse(fs.readFileSync(mapping, "utf8")));
      if (text(value.cwd) !== this.cwd) throw new Error("Harness 会话工作区不匹配");
      const journal = readEvents(journalPath(this.home));
      // 数据库是权威来源，日志只补回数据库尚未写入的事件
      const positions = new Map(journal.map((event, index) => [event.id, index]));
      let previous = -1;
      for (const item of stored) {
        const position = positions.get(item.id);
        if (position === undefined) continue;
        if (position <= previous) throw new Error("Harness 事件日志与数据库历史不一致；请恢复一致的会话备份");
        previous = position;
      }
      const storedIds = new Set(stored.map((item) => item.id));
      this.events = [...stored, ...journal.filter((event) => !storedIds.has(event.id))];
      // 只有 DSH 原生会话真正落盘后才发 session/resume；仅建过空会话目录时由首次 prompt 创建。
      this.sessionExisted = hasDshSession(this.home, this.sessionId);
    } else {
      if (fs.existsSync(mapping)) throw new Error("Harness 会话已存在");
      if (fs.existsSync(journalPath(this.home)) || hasDshSession(this.home, this.sessionId)) {
        throw new Error("Harness 会话历史已存在但映射缺失；请恢复会话备份，而不是重新创建");
      }
      fs.writeFileSync(mapping, JSON.stringify({ threadId: this.sessionId, cwd: this.cwd }), {
        encoding: "utf8",
        mode: 0o600,
      });
      this.events = [];
    }
    for (let index = stored.length; index < this.events.length; index++) {
      this.eventStore.append(this.events[index]!, index + 1);
    }
    await this.eventStore.flush();
  }

  private dispatch(event: SessionEvent) {
    for (const listener of this.listeners) listener(event);
    return event;
  }

  private emit(event: SessionEvent, persist = true) {
    if (persist) {
      fs.appendFileSync(journalPath(this.home), JSON.stringify(event) + "\n", { mode: 0o600 });
      this.events.push(event);
      this.eventStore.append(event, this.events.length);
    }
    return this.dispatch(event);
  }

  private emitAll(events: readonly SessionEvent[]) {
    for (const event of events) {
      this.emit(event);
      if (event.type === "session.idle") this.notifyIdle();
      if (event.type === "session.shutdown") this.notifyIdle();
    }
  }

  private notifyIdle() {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter.resolve();
  }

  private notifyFailure(error: Error) {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const waiter of waiters) waiter.reject(error);
  }

  private waitUntilIdle(timeoutMs: number): { promise: Promise<void>; cancel(): void } {
    let waiter: IdleWaiter;
    let timer: NodeJS.Timeout;
    const promise = new Promise<void>((resolve, reject) => {
      waiter = { resolve, reject };
      this.waiters.add(waiter);
      timer = setTimeout(() => {
        this.waiters.delete(waiter);
        reject(new Error("Harness 回合超时"));
      }, timeoutMs);
    });
    return {
      promise,
      cancel: () => {
        clearTimeout(timer);
        this.waiters.delete(waiter);
      },
    };
  }

  // --- 运行时生命周期 ---

  private providerRoute(): DshProviderRoute {
    const provider = this.config.provider;
    if (!provider) {
      throw new Error("DSH 引擎需要选择已配置的自定义模型服务，不能使用 Codex 内置模型");
    }
    if (provider.type === "azure") {
      throw new Error("DSH 引擎暂不支持 Azure 模型提供方，请改用 OpenAI 兼容或 Anthropic 提供方");
    }
    if (!this.model) throw new Error("Harness 会话需要指定模型");
    const contextWindow = contextWindowOf(this.config);
    return {
      id: ROUTE_ID,
      type: provider.type ?? "openai",
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      wireApi: provider.wireApi,
      headers: provider.headers,
      reasoningEffort: this.reasoningEffort(),
      models: [
        {
          id: this.model,
          ...(contextWindow ? { contextWindow } : {}),
        },
      ],
    };
  }

  private reasoningEffort(): ReasoningEffort | undefined {
    const value = this.effort;
    return value && isReasoningEffort(value) ? value : undefined;
  }

  private mcpRows(): DshMcpRow[] {
    const rows: DshMcpRow[] = [];
    const used = new Set<string>();
    for (const [name, server] of Object.entries(this.config.mcpServers ?? {})) {
      const serverName = mcpServerName(name, used);
      if (server.type === "stdio") {
        rows.push({
          id: `cca-mcp-${serverName}`,
          serverName,
          config: {
            transport: "stdio",
            serverName,
            command: server.command,
            args: server.args ?? [],
            env: server.env ?? {},
            cwd: server.workingDirectory ?? this.cwd,
          },
          timeoutMs: server.timeout,
        });
      } else if (server.type === "http") {
        rows.push({
          id: `cca-mcp-${serverName}`,
          serverName,
          config: {
            transport: "streamable-http",
            serverName,
            url: server.url,
            headers: server.headers ?? {},
          },
          timeoutMs: server.timeout,
        });
      }
    }
    return rows;
  }

  private async ensureRuntime(): Promise<HarnessClient> {
    if (this.closed) throw new Error("Harness 会话已断开");
    if (this.runtime) return this.runtime;
    const route = this.providerRoute();
    const credentials = route.apiKey ? { [credentialEnvName(ROUTE_ID)]: route.apiKey } : {};
    const { patchPath } = prepareDshHome(
      {
        homeDir: this.home,
        skillDirs: this.config.skillDirectories ?? [],
        disabledSkills: this.config.disabledSkills ?? [],
        mcpRows: this.mcpRows(),
        sandboxMode: sandboxModeFor(this.config.permissionMode),
        workspaceRoot: this.cwd,
      },
      [route],
    );
    const client = new HarnessClient({
      dshBin: dshBinPath(),
      profile: "sdk",
      patches: [patchPath],
      dshHome: this.home,
      processCwd: this.cwd,
      env: sanitizedDshRuntimeEnv(this.home, credentials),
    });
    client.start();
    try {
      await client.initialize({
        cwd: this.cwd,
        provider: ROUTE_ID,
        model: this.model ?? "",
      });
      // 运行时重启后必须显式恢复持久化会话，否则会拿同一 id 重新建一个空会话。
      if (this.hasPrompted || this.sessionExisted || hasDshSession(this.home, this.sessionId)) {
        await client.request("session/resume", { sessionId: this.sessionId });
        this.sessionExisted = true;
      }
      if (this.aborted) {
        await client.close().catch(() => {});
        throw new Error("回合已中断");
      }
    } catch (error) {
      await client.close().catch(() => {});
      throw error instanceof Error ? error : new Error(String(error));
    }
    this.runtime = client;
    const subscription = client.subscribeSessionTree(this.sessionId);
    this.pumpTask = this.pump(subscription);
    return client;
  }

  /** 累积 DSH sessionStats；只有会改变可见数字的事件才通知 UI。 */
  private recordStats(notification: { method: string; params: Record<string, unknown> }) {
    if (notification.method !== "session.event") return;
    const params = notification.params as { sessionId?: unknown; event?: DshSessionEvent };
    if (params.sessionId !== this.sessionId || !params.event) return;
    const event = params.event;
    const previous = this.stats;
    const next = applyDshStatsEvent(previous, event);
    this.stats = next;
    if (next === previous) return;
    if (
      event.type !== "assistant/message" &&
      event.type !== "step/end" &&
      event.type !== "tool/result"
    ) {
      return;
    }
    const value = dshRuntimeStats(next);
    for (const listener of this.statsListeners) {
      try {
        listener(value);
      } catch (error) {
        console.error("[cca] DSH stats listener failed", error);
      }
    }
  }

  private async pump(subscription: NotificationSubscription) {
    try {
      for await (const notification of subscription) {
        if (this.closing) continue;
        try {
          this.recordStats(notification);
          this.emitAll(this.mapper.mapNotification(notification.method, notification.params));
        } catch (error) {
          console.error("[cca] Harness event mapping failed", error);
        }
      }
    } catch (error) {
      if (!this.closing && !this.closed) {
        console.warn("[cca] Harness notification stream failed", error);
      }
    }
    if (this.disposing || this.closing) return;
    // 传输非预期终止：收尾并通知上层，会话对象随 manager 重新 attach 而重建。
    const reason = "DeepSeek Harness 运行时已退出，未完成的请求不会自动重发";
    this.emitAll(this.mapper.mapTransportClosed(reason));
    this.notifyFailure(new Error(reason));
    void this.disconnect().catch((error) => console.error("[cca] DSH session cleanup failed", error));
  }

  private async disposeRuntime() {
    const client = this.runtime;
    this.runtime = undefined;
    if (!client) return;
    this.disposing = true;
    try {
      try {
        await client.close();
      } catch (error) {
        console.warn("[cca] DSH runtime close failed", error);
      }
      if (this.pumpTask) {
        await this.pumpTask.catch(() => {});
        this.pumpTask = undefined;
      }
    } finally {
      this.disposing = false;
    }
  }

  // --- 会话操作 ---

  private toContentBlocks(options: MessageOptions): Parameters<HarnessClient["prompt"]>[1] {
    const blocks: { type: "text"; text: string }[] = [{ type: "text", text: options.prompt }];
    for (const attachment of options.attachments ?? []) {
      // DSH 的图片块需要附件服务引用；v1 以文本提及携带路径，模型侧可用文件工具读取
      blocks.push({ type: "text", text: attachmentReferenceText(
        attachment.displayName, "path" in attachment ? attachment.path : undefined,
      ) });
    }
    return blocks as Parameters<HarnessClient["prompt"]>[1];
  }

  async send(prompt: string): Promise<string>;
  async send(options: MessageOptions): Promise<string>;
  async send(input: string | MessageOptions) {
    const options: MessageOptions = typeof input === "string" ? { prompt: input } : input;
    this.aborted = false;
    const client = await this.ensureRuntime();
    if (this.aborted) throw new Error("回合已中断");
    const messageId = await client.prompt(this.sessionId, this.toContentBlocks(options));
    this.hasPrompted = true;
    this.sessionExisted = true;
    return messageId;
  }

  async sendAndWait(prompt: string, timeout?: number): Promise<Extract<SessionEvent, { type: "assistant.message" }> | undefined>;
  async sendAndWait(options: MessageOptions, timeout?: number): Promise<Extract<SessionEvent, { type: "assistant.message" }> | undefined>;
  async sendAndWait(input: string | MessageOptions, timeout = 60_000) {
    const options: MessageOptions = typeof input === "string" ? { prompt: input } : input;
    const waiting = this.waitUntilIdle(timeout);
    const result = waiting.promise;
    const sending = this.send(options);
    try {
      await Promise.all([sending, result]);
      await this.eventStore.flush();
      return [...this.events]
        .reverse()
        .find(
          (event): event is Extract<SessionEvent, { type: "assistant.message" }> =>
            event.type === "assistant.message",
        );
    } catch (error) {
      try {
        await this.abort();
      } catch (abortError) {
        console.warn("[cca] Harness interrupt failed", abortError);
      }
      throw error;
    } finally {
      waiting.cancel();
    }
  }

  async abort() {
    // SDK 协议没有取消原语：回收运行时即中断在途回合；会话日志保留，可继续对话。
    this.aborted = true;
    await this.disposeRuntime();
    this.emitAll(this.mapper.mapAborted("用户中断"));
    this.notifyFailure(new Error("回合已中断"));
    await this.eventStore.flush().catch(() => {});
  }

  async setModel(model: string, options?: SetModelOptions) {
    this.model = model;
    if (options?.reasoningEffort !== undefined) {
      this.effort = String(options.reasoningEffort);
    }
    if (options && "modelCapabilities" in options) {
      this.config.modelCapabilities = options.modelCapabilities;
      this.mapper.setContextWindowTokens(contextWindowOf(this.config));
    }
    await this.disposeRuntime();
  }

  get rpc(): AgentSession["rpc"] {
    return {
      history: {
        compact: async (): Promise<never> => {
          // DSH SDK 协议没有手动压缩请求；压缩由运行时在 token 压力下自动执行。
          throw new Error("DeepSeek Harness 运行时暂不支持手动上下文压缩；压缩会在接近上限时自动执行");
        },
      },
    };
  }

  async disconnect() {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    this.notifyFailure(new Error("Harness 会话已断开"));
    this.statsListeners.clear();
    try {
      await this.disposeRuntime();
    } finally {
      try {
        await this.eventStore.flush();
      } finally {
        this.release();
      }
    }
  }
}

export class DshClient implements AgentClient {
  private sessions = new Map<string, DshSession>();

  async start() {
    fs.mkdirSync(DSH_HOME_ROOT, { recursive: true, mode: 0o700 });
  }

  /** 与其他 AgentClient 一致保留该表面，但 DSH 不提供 Copilot CLI 的插件 rpc。 */
  get rpc(): AgentClient["rpc"] {
    throw new Error("DeepSeek Harness 运行时不提供 Copilot CLI 的 rpc;插件请使用 Agent Plugins 市场安装");
  }

  private async open(
    id: string,
    config: Config,
    resume: boolean,
  ): Promise<AgentSession> {
    sessionPath(id);
    if (config.legacySession) throw new Error("旧引擎会话只读，请新建会话");
    const existing = this.sessions.get(id);
    if (existing) await existing.disconnect().catch(() => {});
    let session: DshSession;
    session = new DshSession(id, config, () => {
      if (this.sessions.get(id) === session) this.sessions.delete(id);
    });
    this.sessions.set(id, session);
    try {
      await session.open(resume);
      return session;
    } catch (error) {
      await session.disconnect().catch(() => {});
      if (this.sessions.get(id) === session) this.sessions.delete(id);
      throw error;
    }
  }

  createSession(config: SessionConfig) {
    // 幂等创建：已有会话目录时恢复而不是重建，避免重连后静默丢失原生历史。
    const id = config.sessionId ?? randomUUID();
    return this.open(id, config, fs.existsSync(mappingPath(sessionPath(id))));
  }

  resumeSession(id: string, config: ResumeSessionConfig) {
    return this.open(id, config, true);
  }

  async deleteSession(id: string) {
    const session = this.sessions.get(id);
    if (session) {
      await session.disconnect().catch(() => {});
      this.sessions.delete(id);
    }
    sessionPath(id);
    await deleteThreadEvents(id);
    fs.rmSync(sessionPath(id), { recursive: true, force: true });
    // 旧引擎遗留会话目录一并清理
    fs.rmSync(path.join(COPILOT_HOME, "session-state", id), { recursive: true, force: true });
    fs.rmSync(path.join(DATA_DIR, "codex-home", id), { recursive: true, force: true });
  }

  async listModels(): Promise<AgentModelInfo[]> {
    // DSH SDK 没有模型发现请求；模型目录来自应用侧的自定义 provider 配置。
    return flattenModels(store.settings).map((option) => {
      const efforts = option.supportedReasoningEfforts?.filter(isReasoningEffort);
      const contextWindow = store.settings.providers
        .find((provider) => provider.id === option.ref.providerId)
        ?.models.find((model) => model.id === option.ref.modelId)?.contextWindowTokens;
      return {
        id: option.ref.modelId,
        name: option.label,
        ...(efforts ? { supportedReasoningEfforts: efforts } : {}),
        ...(option.defaultReasoningEffort
          ? { defaultReasoningEffort: option.defaultReasoningEffort }
          : {}),
        capabilities: {
          supports: { vision: false, reasoningEffort: (efforts?.length ?? 0) > 0 },
          limits: { max_context_window_tokens: contextWindow ?? 0 },
        },
      };
    });
  }

  /** 无工具的一次性文本生成，直接走应用侧 provider，不启动 DSH 运行时。 */
  async generateText(
    config: Pick<SessionConfig, "provider" | "model" | "systemMessage">,
    prompt: string,
    timeout: number,
  ): Promise<string> {
    const provider = config.provider;
    if (!provider) throw new Error("未配置模型服务，无法生成文本");
    if (!config.model) throw new Error("文本生成需要指定模型");
    const gateway = await startLlmGateway({
      type: provider.type ?? "openai",
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      wireApi: provider.wireApi,
      azure: provider.azure,
    });
    try {
      const response = await fetch(gateway.url + "/responses", {
        method: "POST",
        headers: {
          authorization: "Bearer " + gateway.token,
          "content-type": "application/json",
        },
        signal: AbortSignal.timeout(timeout),
        body: JSON.stringify({
          model: config.model,
          instructions: config.systemMessage?.content,
          input: prompt,
          stream: false,
          tools: [],
          tool_choice: "none",
          max_output_tokens: 1024,
        }),
      });
      if (!response.ok) throw new Error("文本生成失败: HTTP " + response.status);
      const result = object(await response.json());
      if (result.status && result.status !== "completed") throw new Error("文本生成未完成");
      const output = array(result.output).map(object);
      if (output.some((item) => item.type !== "message" && item.type !== "reasoning")) {
        throw new Error("文本生成不允许调用工具");
      }
      const content = output
        .filter((item) => item.type === "message")
        .flatMap((item) => array(item.content).map(object))
        .filter((item) => item.type === "output_text")
        .map((item) => text(item.text))
        .join("");
      if (!content.trim()) throw new Error("模型没有返回内容");
      return content;
    } finally {
      await gateway.close();
    }
  }

  async stop() {
    const results = await Promise.allSettled(
      [...this.sessions.values()].map((session) => session.disconnect()),
    );
    this.sessions.clear();
    return results.flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason : new Error(String(result.reason))]
        : [],
    );
  }
}
