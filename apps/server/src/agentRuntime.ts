// 会话运行时抽象缝：CopilotManager 只面向这里的 AgentClient/AgentSession 编程，
// 具体执行核心（DeepSeek Harness SDK 运行时）在 apps/server/src/dsh/ 实现。
// 类型一律来自 @cca/protocol 的内部化契约，不再依赖任何第三方 agent SDK 的类型。
import type {
  AssistantMessageData,
  HistoryCompactResult,
  MessageOptions,
  ModelCapabilitiesOverride,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from "@cca/protocol";
import type { ModelInfo, ReasoningEffort } from "@cca/protocol";

export { SessionNotFoundError } from "./errors.js";

export type AgentModelInfo = Omit<
  ModelInfo,
  "supportedReasoningEfforts" | "defaultReasoningEffort"
> & {
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
};

export interface SetModelOptions {
  reasoningEffort?: ReasoningEffort | string;
  modelCapabilities?: ModelCapabilitiesOverride;
  [key: string]: unknown;
}

export interface AgentSession {
  readonly sessionId: string;
  /** 运行时已断开（进程退出/传输丢失）时为 true。 */
  readonly runtimeDisconnected?: boolean;
  on(handler: (event: SessionEvent) => void): () => void;
  send(options: MessageOptions): Promise<unknown>;
  sendAndWait(
    options: MessageOptions,
    timeoutMs?: number,
  ): Promise<{ data: AssistantMessageData } | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  getEvents(): Promise<SessionEvent[]> | SessionEvent[];
  setModel(model: string, options?: SetModelOptions): void | Promise<void>;
  rpc: {
    history: {
      compact(): Promise<HistoryCompactResult>;
    };
  };
}

export interface AgentClient {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  createSession(config: SessionConfig): Promise<AgentSession>;
  resumeSession(id: string, config: ResumeSessionConfig): Promise<AgentSession>;
  deleteSession(id: string): Promise<void>;
  listModels(): Promise<AgentModelInfo[]>;
  /** 无工具的一次性文本生成（提交信息等场景）。 */
  generateText(config: SessionConfig, prompt: string, timeoutMs: number): Promise<string>;
}

export type CopilotClientFactory = () => AgentClient;

/** 兼容别名：历史代码/测试以 CopilotClient/CopilotSession 引用该抽象缝。 */
export type CopilotClient = AgentClient;
export type CopilotSession = AgentSession;
