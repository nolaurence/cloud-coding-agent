import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MessageOptions, ResumeSessionConfig, SessionConfig, SessionEvent, Tool } from "@github/copilot-sdk";
import type {
  MessageAttachment,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
} from "@cca/protocol";
import type { AgentClient, AgentSession, AgentModelInfo } from "./agentRuntime.js";
import { isReasoningEffort } from "@cca/protocol";
import { COPILOT_HOME, DATA_DIR } from "./env.js";
import { usingDatabase } from "./db.js";
import { ThreadEventStore, deleteThreadEvents } from "./threadEvents.js";
import { CodexRpc } from "./codexRpc.js";
import { retryCodexReconnect } from "./codexReconnect.js";
import { array, object, startLlmGateway, text, type GatewayProvider, type JsonObject } from "./llmGateway.js";
import { sanitizedCopilotRuntimeEnv } from "./runtimeEnv.js";
import { IMAGE_EXTENSIONS, MAX_IMAGE_SIZE, hasImageSignature, storeUploadedImage } from "./uploads.js";
import { startImageGenerationServer, type ImageGenerationProvider } from "./imageGeneration.js";
import { attachmentReferenceText } from "./attachmentPrompt.js";

const CODEX_HOME = path.join(DATA_DIR, "codex-home");
const MAX_CONTEXT_OUTPUT_RESERVE_TOKENS = 16_000;
export class SessionNotFoundError extends Error {}

type Config = (SessionConfig | ResumeSessionConfig) & {
  legacySession?: boolean;
  agentMode?: "standard" | "ultra";
  deniedPaths?: string[];
  imageGenerationProvider?: ImageGenerationProvider;
  imageGenerationModel?: string;
  imageGenerationOwnerId?: string;
  permissionMode?: PermissionMode;
  onCodexPermissionRequest?: (request: PermissionRequest) => Promise<PermissionDecision>;
};
type EventInput = { [K in SessionEvent["type"]]: { type: K; data: Extract<SessionEvent, { type: K }>["data"] & (K extends "assistant.message" ? { attachments?: MessageAttachment[] } : unknown); agentId?: string; id?: string } }[SessionEvent["type"]];
function event(input: EventInput): SessionEvent {
  return { id: randomUUID(), parentId: null, timestamp: new Date().toISOString(), ...input } as SessionEvent;
}
function sessionPath(id: string): string {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(id)) throw new Error("Invalid session id");
  return path.join(CODEX_HOME, id);
}
function configuredContextWindow(config: Config): number | undefined {
  const value = config.modelCapabilities?.limits?.max_context_window_tokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function codexPermissionSettings(mode: PermissionMode | undefined) {
  switch (mode) {
    case "request":
      return {
        approvalPolicy: "on-request" as const,
        sandbox: "workspace-write" as const,
        approvalsReviewer: "user" as const,
        sandboxPolicy: { type: "workspaceWrite", networkAccess: false } as JsonObject,
      };
    case "auto":
      return {
        approvalPolicy: "on-request" as const,
        sandbox: "workspace-write" as const,
        approvalsReviewer: "auto_review" as const,
        sandboxPolicy: { type: "workspaceWrite", networkAccess: false } as JsonObject,
      };
    default:
      return {
        approvalPolicy: "never" as const,
        sandbox: "danger-full-access" as const,
        approvalsReviewer: "user" as const,
        sandboxPolicy: { type: "dangerFullAccess" } as JsonObject,
      };
  }
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function reasoningContent(item: JsonObject): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && typeof (part as JsonObject).text === "string") {
        return String((part as JsonObject).text);
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function runtimeEnv(home: string): NodeJS.ProcessEnv {
  const env = sanitizedCopilotRuntimeEnv();
  for (const key of Object.keys(env)) if (key.startsWith("COPILOT_") || key.startsWith("GH_COPILOT_") || key === "GH_HOST" || key === "SSH_AUTH_SOCK") delete env[key];
  env.CODEX_HOME = home;
  env.HOME = home;
  env.USERPROFILE = home;
  return env;
}
function prepareHome(home: string) {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const auth = path.join(CODEX_HOME, "auth.json");
  if (fs.existsSync(auth)) {
    fs.copyFileSync(auth, path.join(home, "auth.json"));
    fs.chmodSync(path.join(home, "auth.json"), 0o600);
  } else fs.rmSync(path.join(home, "auth.json"), { force: true });
}
function readEvents(file: string): SessionEvent[] {
  if (!fs.existsSync(file)) return [];
  const events: SessionEvent[] = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const parsed = object(JSON.parse(line));
      text(parsed.type); text(parsed.id); text(parsed.timestamp); object(parsed.data);
      events.push(parsed as SessionEvent);
    } catch {
      // 追加写入被中断时日志末行可能只有半条记录,跳过它而不是让整个会话无法打开
      console.error("[cca] skipped a corrupted event journal line", file);
    }
  }
  return events;
}

class ArchivedSession implements AgentSession {
  constructor(readonly sessionId: string) {}
  private unavailable(): never { throw new Error("此会话使用旧 Copilot 引擎,历史记录只读;请新建 Codex 会话"); }
  get rpc(): AgentSession["rpc"] { return { history: { compact: async () => this.unavailable() } }; }
  on() { return () => {}; }
  async getEvents() { return readEvents(path.join(COPILOT_HOME, "session-state", this.sessionId, "events.jsonl")); }
  async send(): Promise<string> { return this.unavailable(); }
  async sendAndWait(): Promise<undefined> { return this.unavailable(); }
  async setModel(): Promise<void> { this.unavailable(); }
  async abort() {}
  async disconnect() {}
}

export class CodexSession implements AgentSession {
  connection: CodexRpc;
  private listeners = new Set<(event: SessionEvent) => void>();
  private threadId = "";
  private turnId: string | undefined;
  private pendingTurn = false;
  private startingTurn: Promise<JsonObject> | undefined;
  private closed = false;
  private gateway: Awaited<ReturnType<typeof startLlmGateway>> | undefined;
  private imageServer: Awaited<ReturnType<typeof startImageGenerationServer>> | undefined;
  private model: string | undefined;
  private effort: string | undefined;
  private permissionMode: PermissionMode;
  private permissionHandler?: (request: PermissionRequest) => Promise<PermissionDecision>;
  private usage: { currentTokens: number; tokenLimit: number } | undefined;
  private events: SessionEvent[] = [];
  private readonly eventStore: ThreadEventStore;
  private readonly home: string;
  private readonly cwd: string;
  private readonly tools: Tool[];
  private readonly waiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  private compacting = false;
  private imageGenerationItems = new Map<string, "running" | "complete">();
  private rawReasoning = new Map<string, { text: string; started: boolean }>();
  private reconnectTask: Promise<void> | undefined;
  private commonConfig: JsonObject | undefined;
  private opened = false;
  get runtimeDisconnected() { return this.closed; }
  constructor(readonly sessionId: string, private readonly config: Config, private readonly release: () => void) {
    this.connection = this.createConnection();
    this.eventStore = new ThreadEventStore(sessionId, () => {
      this.emit({ type: "session.error", data: { errorType: "storage", message: "会话历史写入数据库失败,已保留本地日志;请恢复数据库后重新打开会话" } }, false);
    });
    this.home = sessionPath(sessionId);
    this.cwd = fs.realpathSync(config.workingDirectory ?? process.cwd());
    for (const directory of [DATA_DIR, ...(config.deniedPaths ?? [])]) {
      const denied = fs.existsSync(directory) ? fs.realpathSync(directory) : path.resolve(directory);
      const relative = path.relative(this.cwd, denied);
      if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("工作区包含服务数据或其他受保护工作区,请使用不重叠的项目目录");
    }
    this.tools = config.tools ?? [];
    this.model = config.model;
    this.permissionMode = config.permissionMode ?? "full";
    this.permissionHandler = config.onCodexPermissionRequest;
    const effort: string | undefined = config.reasoningEffort;
    this.effort = config.agentMode === "ultra" ? "xhigh" : effort === "max" ? "xhigh" : effort;
  }
  private createConnection() {
    const connection = new CodexRpc();
    connection.onNotification((method, params) => this.notification(method, params));
    connection.onRequest = (method, params) => this.toolRequest(method, params);
    connection.onFailure = (error) => this.connectionFailed(error);
    return connection;
  }
  private reportFailure(error: Error): Error {
    try {
      this.emit({ type: "session.error", data: { errorType: "codex", message: error.message } });
      return error;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | undefined)?.code;
      const failure = new Error(code === "ENOSPC" || code === "EDQUOT"
        ? "服务端磁盘空间或存储配额不足，请释放空间后重新打开会话"
        : "会话错误记录写入失败，请检查服务端存储后重新打开会话");
      this.emit({ type: "session.error", data: { errorType: "storage", message: failure.message } }, false);
      return failure;
    }
  }
  private failSession(error: Error) {
    let failure = error;
    try {
      failure = this.reportFailure(error);
    } finally {
      try {
        // A failed journal write must not prevent waiters and the UI from leaving
        // the running state, or escape the child-process callback and crash Node.
        this.complete(failure, false, false);
      } finally {
        void this.disconnect().catch((cause: unknown) => console.error("[cca] Codex cleanup failed", cause));
      }
    }
  }
  private connectionFailed(error: Error) {
    if (this.closed || this.reconnectTask) return;
    if (!this.opened) {
      this.failSession(error);
      return;
    }
    console.warn("[cca] Codex connection lost:", error.message);
    const task = this.recover();
    this.reconnectTask = task;
    const clear = () => {
      if (this.reconnectTask === task) this.reconnectTask = undefined;
    };
    void task.then(clear, (failure: unknown) => {
      clear();
      console.error("[cca] Codex reconnect failed", failure);
    });
  }
  private async recover() {
    if (this.turnId || this.pendingTurn || this.startingTurn || this.compacting) {
      const error = new Error("Codex 连接中断，未完成的请求不会自动重发");
      this.turnId = undefined;
      this.pendingTurn = false;
      this.startingTurn = undefined;
      this.compacting = false;
      this.complete(error, false, false);
    }
    try {
      await retryCodexReconnect(async (attempt) => {
        if (this.closed) throw new Error("Codex session closed");
        const connection = this.createConnection();
        try {
          await connection.start(this.cwd, runtimeEnv(this.home));
          if (this.closed) throw new Error("Codex session closed");
          if (!this.commonConfig) throw new Error("Codex reconnect state is unavailable");
          const result = await connection.request("thread/resume", { ...this.commonConfig, threadId: this.threadId });
          const resumedThreadId = text(object(result.thread).id);
          if (resumedThreadId !== this.threadId) throw new Error("Codex resumed an unexpected thread");
          if (this.closed) throw new Error("Codex session closed");
          this.connection = connection;
          this.reconnectTask = undefined;
          console.warn(`[cca] Codex reconnected thread=${this.threadId} attempt=${attempt + 1}`);
        } catch (error) {
          await connection.close().catch(() => {});
          throw error;
        }
      }, { cancelled: () => this.closed });
    } catch (error) {
      if (this.closed) return;
      const failure = error instanceof Error ? error : new Error(String(error));
      this.failSession(new Error("Codex 重连失败: " + failure.message));
    }
  }
  private async waitForReconnect() {
    await this.reconnectTask;
    if (this.closed) throw new Error("Codex session is disconnected");
  }
  private emit(input: EventInput, persist = true) {
    const value = event(input);
    if (persist) {
      fs.appendFileSync(path.join(this.home, "cca-events.jsonl"), JSON.stringify(value) + "\n", { mode: 0o600 });
      this.events.push(value);
      this.eventStore.append(value, this.events.length);
    }
    for (const listener of this.listeners) listener(value);
    return value;
  }
  on(handler: (event: SessionEvent) => void) { this.listeners.add(handler); return () => { this.listeners.delete(handler); }; }
  async getEvents() { return usingDatabase() ? this.eventStore.read() : [...this.events]; }
  async open(resume: boolean) {
    prepareHome(this.home);
    const stored = usingDatabase() ? await this.eventStore.read() : [];
    if (usingDatabase()) {
      if (stored.length && (!resume || !fs.existsSync(path.join(this.home, "cca-thread.json")) || !fs.existsSync(path.join(this.home, "cca-events.jsonl")))) {
        throw new Error("Codex native history or event journal is missing; restore the session backup before resuming");
      }
    }
    const mappingPath = path.join(this.home, "cca-thread.json");
    if (resume) {
      if (!fs.existsSync(mappingPath)) {
        if (fs.existsSync(path.join(this.home, "cca-events.jsonl")) || fs.existsSync(path.join(this.home, "sessions"))) throw new Error("Codex history mapping is missing; restore the session backup instead of recreating it");
        throw new SessionNotFoundError("Codex session not found");
      }
      const mapping = object(JSON.parse(fs.readFileSync(mappingPath, "utf8")));
      if (text(mapping.cwd) !== this.cwd) throw new Error("Codex session workspace mismatch");
      this.threadId = text(mapping.threadId);
      const journal = readEvents(path.join(this.home, "cca-events.jsonl"));
      // 日志可能因写入中断丢掉部分记录,因此数据库中的持久历史是权威来源,日志只用于补回数据库尚未写入的事件
      const positions = new Map(journal.map((event, index) => [event.id, index]));
      let previous = -1;
      for (const value of stored) {
        const position = positions.get(value.id);
        if (position === undefined) continue;
        if (position <= previous) throw new Error("Codex event journal disagrees with database history; restore a consistent session backup");
        previous = position;
      }
      const storedIds = new Set(stored.map((value) => value.id));
      this.events = [...stored, ...journal.filter((event) => !storedIds.has(event.id))];
    } else if (fs.existsSync(mappingPath)) throw new Error("Codex session already exists");
    for (let index = stored.length; index < this.events.length; index++) this.eventStore.append(this.events[index]!, index + 1);
    await this.eventStore.flush();
    const permission = codexPermissionSettings(this.permissionMode);
    const overrides: JsonObject = {
      approval_policy: permission.approvalPolicy,
      sandbox_mode: permission.sandbox,
      approvals_reviewer: permission.approvalsReviewer,
      web_search: "disabled",
      // Custom providers use the registered image_gen MCP tool; the native
      // image extension is not exposed reliably for the cca model provider.
      features: { multi_agent: false, image_generation: false },
      projects: { [this.cwd]: { trust_level: "untrusted" } },
      shell_environment_policy: { inherit: "none", set: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: this.cwd, LANG: "C.UTF-8" } },
      mcp_servers: {},
    };
    const mcp: JsonObject = {};
    for (const [name, server] of Object.entries(this.config.mcpServers ?? {})) {
      const shared = { enabled: true, ...(server.tools && !server.tools.includes("*") ? { enabled_tools: server.tools } : {}),
        ...(server.timeout ? { tool_timeout_sec: server.timeout / 1000 } : {}) };
      mcp[name] = "command" in server
        ? { ...shared, command: server.command, args: server.args ?? [], env: server.env ?? {}, ...(server.workingDirectory ? { cwd: server.workingDirectory } : {}) }
        : { ...shared, url: server.url, http_headers: server.headers ?? {} };
    }
    overrides.mcp_servers = mcp;
    const skillsHome = path.join(this.home, "skills");
    fs.mkdirSync(skillsHome, { recursive: true });
    for (const entry of fs.readdirSync(skillsHome)) fs.rmSync(path.join(skillsHome, entry), { recursive: true, force: true });
    for (const directory of this.config.skillDirectories ?? []) {
      if (!fs.existsSync(directory)) continue;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || this.config.disabledSkills?.includes(entry.name)) continue;
        const source = fs.realpathSync(path.join(directory, entry.name));
        if (!fs.existsSync(path.join(source, "SKILL.md"))) continue;
        const target = path.join(skillsHome, entry.name);
        if (!fs.existsSync(target)) fs.symlinkSync(source, target, "junction");
      }
    }
    const provider = this.config.provider;
    try {
      const imageProvider = this.config.imageGenerationProvider ??
        (provider?.type === "openai" && this.config.imageGenerationModel
          ? { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: this.config.imageGenerationModel }
          : undefined);
      if (imageProvider && this.config.imageGenerationOwnerId) {
        this.imageServer = await startImageGenerationServer(imageProvider, (image) => {
          if (this.closed || !this.turnId) throw new Error("当前没有正在运行的生图任务");
          const attachment = this.saveGeneratedImage(image);
          const directory = path.join(this.home, "generated_images");
          fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
          const imagePath = path.join(directory, attachment.id);
          fs.writeFileSync(imagePath, Buffer.from(text(image.result), "base64"), { mode: 0o600 });
          this.emit({ type: "assistant.message", data: { messageId: "image-" + randomUUID(), content: "", attachments: [attachment] } });
          const mimeType = Object.entries(IMAGE_EXTENSIONS).find(([, extension]) => attachment.id.endsWith(extension))![0];
          return { path: imagePath, mimeType };
        });
        mcp.cca_imagegen = { url: this.imageServer.url, http_headers: { Authorization: "Bearer " + this.imageServer.token }, tool_timeout_sec: 600 };
      }
      if (provider) {
        const gatewayProvider: GatewayProvider = { type: provider.type ?? "openai", baseUrl: provider.baseUrl, apiKey: provider.apiKey, wireApi: provider.wireApi, azure: provider.azure, reasoningEffort: String(this.config.reasoningEffort) === "max" ? "max" : undefined };
        this.gateway = await startLlmGateway(gatewayProvider, this.config.imageGenerationModel ? (item) => {
          const generated = { ...item, type: "imageGeneration" };
          this.item(generated, false);
          this.item(generated, true);
        } : undefined);
        overrides.model_provider = "cca";
        overrides.model_providers = { cca: { name: "CCA", base_url: this.gateway.url, wire_api: "responses", experimental_bearer_token: this.gateway.token, supports_websockets: false, request_max_retries: 0, stream_max_retries: 0 } };
      }
      const contextWindow = configuredContextWindow(this.config);
      if (contextWindow) {
        overrides.model_context_window = contextWindow;
        overrides.model_auto_compact_token_limit = Math.max(
          1,
          contextWindow - Math.min(MAX_CONTEXT_OUTPUT_RESERVE_TOKENS, Math.floor(contextWindow * 0.1)),
        );
      }
      if (this.effort) overrides.model_reasoning_effort = this.effort;
      overrides.show_raw_agent_reasoning = true;
      await this.connection.start(this.cwd, runtimeEnv(this.home));
      const common: JsonObject = { cwd: this.cwd, model: this.model, approvalPolicy: permission.approvalPolicy, sandbox: permission.sandbox, approvalsReviewer: permission.approvalsReviewer, config: overrides,
        developerInstructions: [this.config.systemMessage?.content, ...(this.imageServer ? [
          "本会话已启用生图工具 mcp__cca_imagegen__image_gen（imagegen 技能所说的 image_gen 在此环境中的入口）。用户请求生成新图片时使用此工具;如果工具尚未出现在列表中,先用 tool_search 搜索 +cca_imagegen 加载工具,再调用。工具使用服务端配置的 GPT Image 提供商,凭据已配置,无需额外 OPENAI_API_KEY 或 CLI 回退确认。生成图片会自动作为助手附件显示,工具同时返回本地文件路径。此入口只支持生成新图片,不支持编辑参考图片。",
        ] : [])].filter(Boolean).join("\n"), persistExtendedHistory: true };
      if (provider) common.modelProvider = "cca";
      this.commonConfig = common;
      const start = () => this.connection.request("thread/start", { ...common, experimentalRawEvents: false, dynamicTools: this.tools.map((tool) => ({
        name: tool.name, description: tool.description ?? "", inputSchema: tool.parameters ?? { type: "object", properties: {} },
      })) });
      let result: JsonObject;
      if (resume) {
        try { result = await this.connection.request("thread/resume", { ...common, threadId: this.threadId }); }
        catch (error) {
          // A thread opened without a first turn has no native rollout to resume.
          if (this.events.length || !(error instanceof Error) || error.message !== "no rollout found for thread id " + this.threadId) throw error;
          result = await start();
        }
      } else result = await start();
      this.threadId = text(object(result.thread).id);
      fs.writeFileSync(mappingPath + ".tmp", JSON.stringify({ threadId: this.threadId, cwd: this.cwd }), { mode: 0o600 });
      fs.renameSync(mappingPath + ".tmp", mappingPath);
      this.opened = true;
    } catch (error) { await this.disconnect(); throw error; }
  }
  private async permissionDecision(request: PermissionRequest): Promise<PermissionDecision> {
    if (this.permissionMode === "full") return "accept";
    if (!this.permissionHandler) return "decline";
    try {
      return await this.permissionHandler(request);
    } catch (error) {
      console.warn("[cca] Codex permission request failed", error);
      return "decline";
    }
  }
  private async approvalRequest(method: string, params: JsonObject): Promise<JsonObject> {
    const itemId = optionalText(params.itemId) ?? randomUUID();
    const requestId = optionalText(params.approvalId) ?? `${itemId}:${randomUUID()}`;
    const reason = optionalText(params.reason);
    if (method === "item/permissions/requestApproval") {
      const decision = await this.permissionDecision({
        requestId,
        kind: "permissions",
        cwd: optionalText(params.cwd) ?? this.cwd,
        reason,
      });
      return decision === "accept"
        ? { permissions: object(params.permissions), scope: "turn" }
        : { permissions: {}, scope: "turn" };
    }
    const kind = method === "item/fileChange/requestApproval" ? "file" : "command";
    const decision = await this.permissionDecision({
      requestId,
      kind,
      ...(kind === "command" && optionalText(params.command) ? { command: optionalText(params.command) } : {}),
      cwd: optionalText(params.cwd) ?? this.cwd,
      reason,
    });
    return { decision };
  }
  private async toolRequest(method: string, params: JsonObject): Promise<JsonObject> {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval"
    ) {
      return this.approvalRequest(method, params);
    }
    if (method !== "item/tool/call") throw new Error("Unsupported Codex request: " + method);
    if (params.threadId !== this.threadId || params.turnId !== this.turnId || this.closed) throw new Error("Tool call does not belong to the active session turn");
    const name = text(params.tool);
    const tool = this.tools.find((candidate) => candidate.name === name);
    if (!tool?.handler) throw new Error("Tool is not enabled: " + name);
    try {
      const result: unknown = await tool.handler(params.arguments, { sessionId: this.sessionId, toolCallId: text(params.callId), toolName: name, arguments: params.arguments });
      const value = typeof result === "string" ? { textResultForLlm: result, resultType: "success" } : object(result);
      const contentItems: JsonObject[] = [{ type: "inputText", text: typeof value.textResultForLlm === "string" ? value.textResultForLlm : JSON.stringify(result) }];
      for (const raw of array(value.binaryResultsForLlm ?? [])) {
        const binary = object(raw);
        if (binary.type === "image") contentItems.push({ type: "inputImage", imageUrl: "data:" + text(binary.mimeType) + ";base64," + text(binary.data) });
      }
      return { success: !value.resultType || value.resultType === "success", contentItems };
    } catch (error) {
      return { success: false, contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : "Tool execution failed" }] };
    }
  }
  private notification(method: string, params: JsonObject) {
    if (params.threadId !== this.threadId) return;
    if (method === "turn/started") {
      this.turnId = text(object(params.turn).id);
      if (!this.compacting) this.emit({ type: "assistant.turn_start", data: { turnId: this.turnId } });
    } else if (method === "turn/plan/updated") {
      const toolCallId = `plan:${text(params.turnId) || this.turnId}:${randomUUID()}`;
      this.emit({ type: "tool.execution_start", data: { toolCallId, toolName: "update_plan", arguments: { plan: params.plan, explanation: params.explanation } } });
      this.emit({ type: "tool.execution_complete", data: { toolCallId, success: true, result: { content: "计划已更新" } } });
    } else if (method === "item/agentMessage/delta") {
      this.emit({ type: "assistant.message_delta", data: { messageId: text(params.itemId), deltaContent: text(params.delta) } }, false);
    } else if (method === "item/reasoning/summaryTextDelta") {
      this.emit({ type: "assistant.reasoning_delta", data: { reasoningId: text(params.itemId), deltaContent: text(params.delta) } });
    } else if (method === "item/reasoning/textDelta") {
      this.appendRawReasoning(text(params.itemId), text(params.delta));
    } else if (method === "item/started" || method === "item/completed") {
      this.item(object(params.item), method === "item/completed");
    } else if (method === "thread/tokenUsage/updated") {
      const usage = object(params.tokenUsage);
      const last = object(usage.last);
      const configuredLimit = configuredContextWindow(this.config);
      const nativeLimit = typeof usage.modelContextWindow === "number" ? usage.modelContextWindow : undefined;
      const tokenLimit = configuredLimit ?? nativeLimit;
      if (tokenLimit !== undefined && typeof last.totalTokens === "number") {
        this.usage = { currentTokens: last.totalTokens, tokenLimit };
        this.emit({ type: "session.usage_info", data: { ...this.usage, messagesLength: this.events.filter((e) => ["user.message", "assistant.message"].includes(e.type)).length } });
      }
    } else if (method === "error") {
      if (!params.willRetry) this.emit({ type: "session.error", data: { errorType: "codex", message: text(object(params.error).message) } });
    } else if (method === "thread/compacted" && this.compacting) {
      this.complete();
    } else if (method === "turn/completed") {
      const turn = object(params.turn);
      const error = turn.status === "failed" ? new Error(turn.error ? text(object(turn.error).message) : "Codex turn failed") : undefined;
      if (error) this.emit({ type: "session.error", data: { errorType: "codex", message: error.message } });
      this.complete(error, turn.status === "interrupted");
    }
  }
  private appendRawReasoning(itemId: string, delta: string) {
    if (!delta) return;
    let state = this.rawReasoning.get(itemId);
    if (!state) {
      state = { text: "", started: false };
      this.rawReasoning.set(itemId, state);
    }
    state.text += delta;
    if (state.started) return;
    state.started = true;
    this.emit({
      type: "tool.execution_start",
      data: { toolCallId: `reasoning:${itemId}`, toolName: "reasoning", arguments: {} },
    });
  }
  private completeRawReasoning(itemId: string, content: string) {
    const state = this.rawReasoning.get(itemId);
    const value = (content || state?.text || "").trim();
    this.rawReasoning.delete(itemId);
    if (!value) return;
    if (!state?.started) {
      this.emit({
        type: "tool.execution_start",
        data: { toolCallId: `reasoning:${itemId}`, toolName: "reasoning", arguments: {} },
      });
    }
    this.emit({
      type: "tool.execution_complete",
      data: { toolCallId: `reasoning:${itemId}`, success: true, result: { content: value } },
    });
  }
  private item(item: JsonObject, done: boolean) {
    const id = text(item.id);
    if (item.type === "agentMessage") {
      if (done) this.emit({ type: "assistant.message", data: { messageId: id, content: text(item.text) } });
      return;
    }
    if (item.type === "reasoning") {
      if (done) this.completeRawReasoning(id, reasoningContent(item));
      else {
        const content = reasoningContent(item);
        if (content) this.appendRawReasoning(id, content);
      }
      return;
    }
    if (item.type === "imageGeneration") {
      const previous = this.imageGenerationItems.get(id);
      if (previous === "complete" || (!done && previous === "running")) return;
      this.imageGenerationItems.set(id, done ? "complete" : "running");
      if (!done) {
        this.emit({ type: "tool.execution_start", data: { toolCallId: id, toolName: "image_generation", arguments: {} } });
      } else {
        try {
          if (item.status !== "completed") throw new Error("图片生成未完成");
          const attachment = this.saveGeneratedImage(item);
          this.emit({ type: "tool.execution_complete", data: { toolCallId: id, success: true, result: { content: attachment.displayName } } });
          this.emit({ type: "assistant.message", data: { messageId: "image-" + id, content: "", attachments: [attachment] } });
        } catch (error) {
          const message = "生成图片保存失败：" + (error instanceof Error ? error.message : "未知错误");
          this.emit({ type: "tool.execution_complete", data: { toolCallId: id, success: false, error: { message } } });
          this.emit({ type: "session.error", data: { errorType: "image_generation", message } });
        }
      }
      return;
    }
    if (item.type === "userMessage") return;
    if (item.type === "contextCompaction") return;
    const names: Record<string, string> = { commandExecution: "bash", fileChange: "apply_patch", mcpToolCall: String(item.tool), dynamicToolCall: String(item.tool), collabAgentToolCall: String(item.tool), webSearch: "web_search", imageView: "view_image" };
    const name = names[String(item.type)];
    if (!name) return;
    if (!done) {
      this.emit({ type: "tool.execution_start", data: { toolCallId: id, toolName: name, arguments: item,
        ...(item.type === "mcpToolCall" ? { mcpServerName: text(item.server), mcpToolName: text(item.tool) } : {}) } });
    } else {
      const success = item.status !== "failed" && item.status !== "declined" && item.success !== false && !(typeof item.exitCode === "number" && item.exitCode !== 0);
      this.emit({ type: "tool.execution_complete", data: { toolCallId: id, success, result: { content: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : JSON.stringify(item).slice(0, 16000) } } });
    }
  }
  private saveGeneratedImage(item: JsonObject): MessageAttachment {
    if ((!this.config.imageGenerationProvider && !this.config.imageGenerationModel) || !this.config.imageGenerationOwnerId) throw new Error("未配置可用的 GPT Image 提供商");
    const result = text(item.result);
    if (result.length > Math.ceil(MAX_IMAGE_SIZE / 3) * 4) throw new Error("单张图片不能超过 10 MB");
    if (!result || !/^[A-Za-z0-9+/]+={0,2}$/.test(result)) throw new Error("图片内容不是有效的 Base64");
    const buffer = Buffer.from(result, "base64");
    const mimeType = (Object.keys(IMAGE_EXTENSIONS) as Array<keyof typeof IMAGE_EXTENSIONS>)
      .find((candidate) => hasImageSignature(buffer, candidate));
    if (!mimeType) throw new Error("图片格式不受支持");
    const displayName = "生成图片" + IMAGE_EXTENSIONS[mimeType];
    const stored = storeUploadedImage(this.config.imageGenerationOwnerId, buffer, mimeType, displayName);
    return { id: stored.imageId, displayName, kind: "image", ownerId: this.config.imageGenerationOwnerId };
  }
  private complete(error?: Error, aborted = false, persist = true) {
    this.turnId = undefined;
    this.pendingTurn = false;
    if (!this.compacting) this.emit({ type: "session.idle", data: { aborted } }, persist);
    for (const waiter of this.waiters) error || aborted ? waiter.reject(error ?? new Error("Codex turn interrupted")) : waiter.resolve();
    this.waiters.clear();
  }
  async send(input: string | MessageOptions): Promise<string> {
    await this.waitForReconnect();
    if (this.pendingTurn || this.turnId || this.compacting) throw new Error("Codex turn already running");
    this.eventStore.assertHealthy();
    const options = typeof input === "string" ? { prompt: input } : input;
    const inputs: JsonObject[] = [{ type: "text", text: options.prompt, text_elements: [] }];
    for (const attachment of options.attachments ?? []) {
      if (attachment.type !== "file") throw new Error("Unsupported attachment type");
      if (/\.(png|jpe?g|gif|webp)$/i.test(attachment.path)) inputs.push({ type: "localImage", path: attachment.path });
      else {
        inputs.push({ type: "mention", name: attachment.displayName ?? path.basename(attachment.path), path: attachment.path });
        // Native mentions preserve references but omit ordinary file paths from model input.
        inputs.push({ type: "text", text: attachmentReferenceText(attachment.displayName, attachment.path), text_elements: [] });
      }
    }
    this.pendingTurn = true;
    const message = this.emit({ type: "user.message", data: { content: options.prompt } });
    try {
      const permission = codexPermissionSettings(this.permissionMode);
      this.startingTurn = this.connection.request("turn/start", { threadId: this.threadId, input: inputs, cwd: this.cwd,
        model: this.model, effort: this.effort, approvalPolicy: permission.approvalPolicy,
        sandboxPolicy: permission.sandboxPolicy, approvalsReviewer: permission.approvalsReviewer });
      await this.startingTurn;
      return message.id;
    } catch (error) { this.pendingTurn = false; throw error; }
    finally { this.startingTurn = undefined; }
  }
  private waitUntilIdle(timeout: number) {
    let waiter: { resolve(): void; reject(error: Error): void };
    let timer: NodeJS.Timeout;
    const promise = new Promise<void>((resolve, reject) => {
      waiter = { resolve, reject };
      this.waiters.add(waiter);
      timer = setTimeout(() => { this.waiters.delete(waiter); reject(new Error("Codex turn timed out")); }, timeout);
    });
    return { promise, cancel: () => { clearTimeout(timer); this.waiters.delete(waiter); } };
  }
  async sendAndWait(input: string | MessageOptions, timeout = 60_000) {
    const waiting = this.waitUntilIdle(timeout);
    const result = waiting.promise;
    // Attach rejection handling before send, since the RPC can fail or finish immediately.
    const sending = this.send(input);
    try {
      await Promise.all([sending, result]);
      await this.eventStore.flush();
      return [...this.events].reverse().find((e): e is Extract<SessionEvent, { type: "assistant.message" }> => e.type === "assistant.message");
    } catch (error) {
      try { await this.abort(); } catch (abortError) { console.warn("[cca] Codex interrupt failed", abortError); }
      throw error;
    }
    finally { waiting.cancel(); }
  }
  async abort() {
    this.imageServer?.abort();
    if (this.reconnectTask) return;
    if (this.startingTurn) await this.startingTurn;
    if (this.turnId) await this.connection.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
  }
  async setModel(model: string, options?: Parameters<AgentSession["setModel"]>[1]) {
    await this.waitForReconnect();
    if (this.pendingTurn || this.turnId || this.compacting) throw new Error("Cannot change model during an active turn");
    this.model = model;
    this.effort = options?.reasoningEffort;
    await this.disconnect();
  }
  get rpc(): AgentSession["rpc"] {
    return { history: { compact: async () => {
      await this.waitForReconnect();
      if (this.pendingTurn || this.turnId || this.compacting) throw new Error("Cannot compact an active turn");
      const before = this.usage?.currentTokens ?? 0;
      this.compacting = true;
      const waiting = this.waitUntilIdle(120_000);
      try {
        await Promise.all([this.connection.request("thread/compact/start", { threadId: this.threadId }), waiting.promise]);
        return { success: true, tokensRemoved: Math.max(0, before - (this.usage?.currentTokens ?? before)), messagesRemoved: 0, ...(this.usage ? { contextWindow: { ...this.usage, messagesLength: this.events.filter((e) => e.type === "user.message" || e.type === "assistant.message").length } } : {}) };
      } finally {
        waiting.cancel();
        this.compacting = false;
        // Codex 0.114 can retain its compaction task; resume the persisted thread before the next turn.
        if (!this.reconnectTask) await this.disconnect();
      }
    } } };
  }
  async disconnect() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters) waiter.reject(new Error("Codex session disconnected"));
    this.waiters.clear();
    try { await this.connection.close(); }
    finally { try { await this.imageServer?.close(); } finally { try { await this.gateway?.close(); } finally { try { await this.eventStore.flush(); } finally { this.release(); } } } }
  }
}

export class CodexClient implements AgentClient {
  private sessions = new Set<CodexSession>();
  async start() { fs.mkdirSync(CODEX_HOME, { recursive: true, mode: 0o700 }); }
  get rpc(): AgentClient["rpc"] { throw new Error("Codex 运行时不提供 Copilot CLI 的 rpc;插件请使用 Agent Plugins 市场安装"); }
  private async open(id: string, config: Config, resume: boolean): Promise<AgentSession> {
    sessionPath(id);
    if (Array.isArray(config.availableTools) && config.availableTools.length === 0) throw new Error("Codex app-server cannot disable every built-in tool; use generateText for tool-free requests");
    if (config.legacySession) return new ArchivedSession(id);
    const session = new CodexSession(id, config, () => this.sessions.delete(session));
    this.sessions.add(session);
    try { await session.open(resume); return session; }
    catch (error) { await session.disconnect(); throw error; }
  }
  async generateText(config: Pick<SessionConfig, "provider" | "model" | "systemMessage">, prompt: string, timeout: number): Promise<string> {
    const provider = config.provider;
    if (!provider) throw new Error("原生 Codex 账号暂不支持无工具提交信息生成,请手动填写或配置自定义模型服务");
    if (!config.model) throw new Error("提交信息生成需要指定模型");
    const gateway = await startLlmGateway({ type: provider.type ?? "openai", baseUrl: provider.baseUrl, apiKey: provider.apiKey, wireApi: provider.wireApi, azure: provider.azure });
    try {
      const response = await fetch(gateway.url + "/responses", {
        method: "POST", headers: { authorization: "Bearer " + gateway.token, "content-type": "application/json" },
        signal: AbortSignal.timeout(timeout),
        body: JSON.stringify({ model: config.model, instructions: config.systemMessage?.content, input: prompt, stream: false, tools: [], tool_choice: "none", max_output_tokens: 1024 }),
      });
      if (!response.ok) throw new Error("提交信息生成失败: HTTP " + response.status);
      const result = object(await response.json());
      if (result.status && result.status !== "completed") throw new Error("提交信息生成未完成");
      const output = array(result.output).map(object);
      if (output.some((item) => item.type !== "message" && item.type !== "reasoning")) throw new Error("提交信息生成不允许调用工具");
      const content = output.filter((item) => item.type === "message").flatMap((item) => array(item.content).map(object)).filter((item) => item.type === "output_text").map((item) => text(item.text)).join("");
      if (!content.trim()) throw new Error("模型没有返回提交信息");
      return content;
    } finally { await gateway.close(); }
  }
  createSession(config: SessionConfig) { return this.open(config.sessionId ?? randomUUID(), config, false); }
  resumeSession(id: string, config: ResumeSessionConfig) { return this.open(id, config, true); }
  async deleteSession(id: string) {
    for (const session of this.sessions) if (session.sessionId === id) await session.disconnect();
    sessionPath(id);
    await deleteThreadEvents(id);
    fs.rmSync(sessionPath(id), { recursive: true, force: true });
    fs.rmSync(path.join(COPILOT_HOME, "session-state", id), { recursive: true, force: true });
  }
  async listModels(): Promise<AgentModelInfo[]> {
    const home = path.join(CODEX_HOME, "model-discovery");
    prepareHome(home);
    const connection = new CodexRpc();
    try {
      await connection.start(home, runtimeEnv(home));
      const result = await connection.request("model/list", {});
      return array(result.data).map((raw): AgentModelInfo => {
        const model = object(raw);
        const efforts = array(model.supportedReasoningEfforts).map((raw) => text(object(raw).reasoningEffort)).filter(isReasoningEffort);
        return { id: text(model.model), name: text(model.displayName), supportedReasoningEfforts: efforts,
          ...(isReasoningEffort(model.defaultReasoningEffort) ? { defaultReasoningEffort: model.defaultReasoningEffort } : {}),
          capabilities: { supports: { vision: array(model.inputModalities).includes("image"), reasoningEffort: efforts.length > 0 }, limits: { max_context_window_tokens: 0 } } };
      });
    } finally { await connection.close(); }
  }
  async stop() {
    const results = await Promise.allSettled([...this.sessions].map((session) => session.disconnect()));
    return results.flatMap((result) => result.status === "rejected" ? [result.reason instanceof Error ? result.reason : new Error(String(result.reason))] : []);
  }
}
