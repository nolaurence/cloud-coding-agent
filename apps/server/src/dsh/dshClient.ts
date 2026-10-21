// DeepSeek Harness 执行核心：AgentClient/AgentSession 的 DSH 实现。
//
// 架构：每个会话（线程）拥有一个 `dsh --profile sdk` 运行时子进程（stdio JSON-RPC，
// 由 @deepseek-ai/dsh-sdk-client 驱动）。SDK 协议只暴露 initialize / session/prompt /
// shutdown 三个请求与 session.event / session.status / subagent.* 四类通知，因此：
//   - 模型路由（BYOK）、MCP、技能、沙箱在 spawn 前写入会话专属的 $DSH_HOME 与 --patch；
//   - 取消（abort）协议没有在途取消，只能回收运行时子进程，会话日志保留、下次拉起续跑；
//   - 会话事件由 DshEventMapper 投影为应用 SessionEvent 契约，再走与旧核心相同的
//     内存 + JSONL 写前日志 + ThreadEventStore 持久化路径。
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { HarnessClient, type NotificationSubscription } from "@deepseek-ai/dsh-sdk-client";
import type {
  HistoryCompactResult,
  MessageOptions,
  MCPServerConfig,
  ModelCapabilitiesOverride,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from "@cca/protocol";
import { flattenModels, isReasoningEffort } from "@cca/protocol";
import type { AgentClient, AgentModelInfo, AgentSession, SetModelOptions } from "../agentRuntime.js";
import { SessionNotFoundError } from "../errors.js";
import { usingDatabase } from "../db.js";
import { COPILOT_HOME, DATA_DIR } from "../env.js";
import { store } from "../store.js";
import { ThreadEventStore, deleteThreadEvents } from "../threadEvents.js";
import { array, object, startLlmGateway, text } from "../llmGateway.js";
import { sanitizedDshRuntimeEnv } from "../runtimeEnv.js";
import {
  AGENT_TOOLS_BRIDGE_TOKEN,
  AGENT_TOOLS_SERVER_NAME,
  agentToolsMcpUrl,
} from "../mcpToolsServer.js";
import { DshEventMapper } from "./dshEvents.js";
import {
  credentialEnvName,
  dshRuntimeCommand,
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
};

function sessionPath(id: string): string {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new Error("Invalid session id");
  return path.join(DSH_HOME_ROOT, id);
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
      console.error("[cca] skipped a corrupted event journal line", file);
    }
  }
  return events;
}

/** 旧引擎（Copilot / Codex）会话：历史只读归档。 */
class ArchivedSession implements AgentSession {
  constructor(readonly sessionId: string) {}
  private unavailable(): never {
    throw new Error("此会话使用旧执行引擎，历史记录只读；请新建 DeepSeek Harness 会话");
  }
  get runtimeDisconnected() {
    return true;
  }
  get rpc(): AgentSession["rpc"] {
    return {
      history: {
        compact: async () => this.unavailable(),
      },
    };
  }
  on() {
    return () => {};
  }
  async getEvents() {
    if (usingDatabase()) {
      const stored = await new ThreadEventStore(this.sessionId, () => {}).read();
      if (stored.length) return stored;
    }
    for (const file of [
      path.join(DSH_HOME_ROOT, this.sessionId, "cca-sessions", "cca-events.jsonl"),
      path.join(COPILOT_HOME, "session-state", this.sessionId, "events.jsonl"),
    ]) {
      const events = readEvents(file);
      if (events.length) return events;
    }
    return [];
  }
  async send(): Promise<string> {
    return this.unavailable();
  }
  async sendAndWait(): Promise<undefined> {
    return this.unavailable();
  }
  async setModel(): Promise<void> {
    this.unavailable();
  }
  async abort() {}
  async disconnect() {}
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
  private waiters = new Set<IdleWaiter>();

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

  async getEvents() {
    return usingDatabase() ? this.eventStore.read() : [...this.events];
  }

  async open(resume: boolean) {
    fs.mkdirSync(this.home, { recursive: true, mode: 0o700 });
    const stored = usingDatabase() ? await this.eventStore.read() : [];
    if (usingDatabase()) {
      if (
        stored.length &&
        (!resume ||
          !fs.existsSync(path.join(this.home, "cca-thread.json")) ||
          !fs.existsSync(path.join(this.home, "cca-events.jsonl")))
      ) {
        throw new Error("Harness 本地事件日志缺失；请先恢复会话备份再继续");
      }
    }
    const mappingPath = path.join(this.home, "cca-thread.json");
    if (resume) {
      if (!fs.existsSync(mappingPath)) {
        if (fs.existsSync(path.join(this.home, "cca-events.jsonl")) || fs.existsSync(path.join(this.home, "dsh"))) {
          throw new Error("Harness 会话映射缺失；请恢复会话备份，而不是重新创建");
        }
        throw new SessionNotFoundError("DeepSeek Harness session not found");
      }
      const mapping = object(JSON.parse(fs.readFileSync(mappingPath, "utf8")));
      if (text(mapping.cwd) !== this.cwd) throw new Error("Harness 会话工作区不匹配");
      const journal = readEvents(path.join(this.home, "cca-events.jsonl"));
      // 数据库是权威来源，日志只补回数据库尚未写入的事件
      const positions = new Map(journal.map((event, index) => [event.id, index]));
      let previous = -1;
      for (const value of stored) {
        const position = positions.get(value.id);
        if (position === undefined) continue;
        if (position <= previous) throw new Error("Harness 事件日志与数据库历史不一致；请恢复一致的会话备份");
        previous = position;
      }
      const storedIds = new Set(stored.map((value) => value.id));
      this.events = [...stored, ...journal.filter((event) => !storedIds.has(event.id))];
    } else if (fs.existsSync(mappingPath)) {
      throw new Error("Harness 会话已存在");
    } else {
      fs.writeFileSync(mappingPath, JSON.stringify({ threadId: this.sessionId, cwd: this.cwd }), "utf8");
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
      fs.appendFileSync(path.join(this.home, "cca-events.jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
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
    if (!provider) throw new Error("未配置模型服务，无法启动 Harness 会话");
    if (!this.model) throw new Error("Harness 会话需要指定模型");
    return {
      id: ROUTE_ID,
      type: provider.type ?? "openai",
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      wireApi: provider.wireApi,
      headers: provider.headers,
      azure: provider.azure,
      models: [{ id: this.model }],
    };
  }

  private mcpRows(): DshMcpRow[] {
    const rows: DshMcpRow[] = [];
    for (const [name, server] of Object.entries(this.config.mcpServers ?? {})) {
      const serverName = name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
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
    // 自定义工具（authenticated_git / browser_use / manage_*）经应用自身的 MCP 桥接入
    const bridgeUrl = agentToolsMcpUrl();
    if (bridgeUrl && (this.config.tools?.length ?? 0) > 0) {
      rows.push({
        id: "cca-agent-tools",
        serverName: AGENT_TOOLS_SERVER_NAME,
        config: {
          transport: "streamable-http",
          serverName: AGENT_TOOLS_SERVER_NAME,
          url: bridgeUrl,
          headers: {
            authorization: "Bearer " + AGENT_TOOLS_BRIDGE_TOKEN,
            "x-cca-thread-id": this.sessionId,
          },
        },
        timeoutMs: 60_000,
      });
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
    const { command, prefixArgs } = dshRuntimeCommand();
    const client = new HarnessClient({
      command,
      args: [...prefixArgs, "--profile", "sdk", "--patch", patchPath],
      cwd: this.cwd,
      env: sanitizedDshRuntimeEnv(this.home, credentials),
    });
    client.start();
    try {
      await client.initialize({
        cwd: this.cwd,
        provider: ROUTE_ID,
        model: this.model ?? "",
        ...(this.effort ? {} : {}),
      });
    } catch (error) {
      await client.close().catch(() => {});
      throw error instanceof Error ? error : new Error(String(error));
    }
    this.runtime = client;
    const subscription = client.subscribeSessionTree(this.sessionId);
    this.pumpTask = this.pump(subscription);
    return client;
  }

  private async pump(subscription: NotificationSubscription) {
    try {
      for await (const notification of subscription) {
        if (this.closing) continue;
        try {
          this.emitAll(this.mapper.mapNotification(notification.method, notification.params));
        } catch (error) {
          console.error("[cca] Harness event mapping failed", error);
        }
      }
    } catch (error) {
      if (!this.closing && !this.closed) {
        console.error("[cca] Harness notification stream failed", error);
      }
    }
    if (this.disposing || this.closing) return;
    // 传输非预期终止：收尾并通知上层
    const reason = "DeepSeek Harness 运行时已退出，未完成的请求不会自动重发";
    this.emitAll(this.mapper.mapTransportClosed(reason));
    this.notifyFailure(new Error(reason));
  }

  /** 回收运行时子进程（协议没有在途取消，回收即中断）。 */
  private async disposeRuntime(quiet: boolean) {
    const client = this.runtime;
    this.runtime = undefined;
    if (!client) return;
    this.disposing = true;
    try {
      await client.close();
    } finally {
      this.disposing = false;
    }
    if (this.pumpTask) {
      await this.pumpTask.catch(() => {});
      this.pumpTask = undefined;
    }
    if (quiet) return;
  }

  // --- 会话操作 ---

  private toContentBlocks(options: MessageOptions): Parameters<HarnessClient["prompt"]>[1] {
    const blocks: { type: "text"; text: string }[] = [{ type: "text", text: options.prompt }];
    for (const attachment of options.attachments ?? []) {
      // DSH 的图片块需要附件服务引用；v1 以文本提及携带路径，模型侧可用文件工具读取
      blocks.push({ type: "text", text: `\n<附件：${attachment.displayName ?? attachment.path}（${attachment.path}）>` });
    }
    return blocks as Parameters<HarnessClient["prompt"]>[1];
  }

  async send(options: MessageOptions) {
    const client = await this.ensureRuntime();
    return client.prompt(this.sessionId, this.toContentBlocks(options));
  }

  async sendAndWait(options: MessageOptions, timeout = 60_000) {
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
    const client = this.runtime;
    this.runtime = undefined;
    if (client) {
      this.disposing = true;
      try {
        await client.close();
      } finally {
        this.disposing = false;
      }
      if (this.pumpTask) {
        await this.pumpTask.catch(() => {});
        this.pumpTask = undefined;
      }
    }
    this.emitAll(this.mapper.mapAborted("用户中断"));
    this.notifyFailure(new Error("回合已中断"));
  }

  async setModel(model: string, options?: SetModelOptions) {
    this.model = model;
    if (options?.reasoningEffort !== undefined) {
      this.effort = String(options.reasoningEffort);
    }
    await this.disposeRuntime(true);
  }

  get rpc(): AgentSession["rpc"] {
    return {
      history: {
        compact: async (): Promise<HistoryCompactResult> => {
          // DSH SDK 协议没有手动压缩请求；压缩由运行时在 token 压力下经 Compaction 插件自动执行。
          throw new Error(
            "DeepSeek Harness 运行时暂不支持手动上下文压缩；压缩会在上下文接近上限时自动执行",
          );
        },
      },
    };
  }

  async disconnect() {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    this.notifyFailure(new Error("Harness 会话已断开"));
    try {
      await this.disposeRuntime(true);
    } finally {
      try {
        await this.eventStore.flush();
      } finally {
        this.release();
      }
    }
  }

  /** 供 generateText 等场景读取当前会话模型配置。 */
  get sessionConfig() {
    return this.config;
  }

  /** 图片生成等宿主扩展暂未接入 DSH 运行时；保留空实现以免调用方分支。 */
  get effortLevel() {
    return this.effort;
  }
}

export class DshClient implements AgentClient {
  private sessions = new Set<DshSession>();

  async start() {
    fs.mkdirSync(DSH_HOME_ROOT, { recursive: true, mode: 0o700 });
  }

  private async open(id: string, config: Config, resume: boolean): Promise<AgentSession> {
    sessionPath(id);
    if (config.legacySession) return new ArchivedSession(id);
    const session = new DshSession(id, config, () => this.sessions.delete(session));
    this.sessions.add(session);
    try {
      await session.open(resume);
      return session;
    } catch (error) {
      await session.disconnect();
      throw error;
    }
  }

  createSession(config: SessionConfig) {
    return this.open(config.sessionId ?? randomUUID(), config, false);
  }

  resumeSession(id: string, config: ResumeSessionConfig) {
    return this.open(id, config, true);
  }

  async deleteSession(id: string) {
    for (const session of [...this.sessions]) {
      if (session.sessionId === id) await session.disconnect();
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
      return {
        id: option.ref.modelId,
        name: option.label,
        ...(efforts ? { supportedReasoningEfforts: efforts } : {}),
        ...(option.defaultReasoningEffort ? { defaultReasoningEffort: option.defaultReasoningEffort } : {}),
        capabilities: {
          supports: { reasoningEffort: (efforts?.length ?? 0) > 0 },
          limits: { max_context_window_tokens: 0 },
        },
      };
    });
  }

  async generateText(config: SessionConfig, prompt: string, timeout: number): Promise<string> {
    const provider = config.provider;
    if (!provider) throw new Error("未配置模型服务，请手动填写或配置自定义模型服务");
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
    const results = await Promise.allSettled([...this.sessions].map((session) => session.disconnect()));
    return results.flatMap((result) =>
      result.status === "rejected"
        ? [result.reason instanceof Error ? result.reason : new Error(String(result.reason))]
        : [],
    );
  }
}

function contextWindowOf(config: Config): number | undefined {
  const value = (config.modelCapabilities as ModelCapabilitiesOverride | undefined)?.limits
    ?.max_context_window_tokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export type { MCPServerConfig };
