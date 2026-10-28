import type { CopilotClient, CopilotSession, SessionConfig, ResumeSessionConfig, SessionEvent, ModelInfo } from "@github/copilot-sdk";

import type { ReasoningEffort, RuntimeStats } from "@cca/protocol";

export type AgentModelInfo = Omit<ModelInfo, "supportedReasoningEfforts" | "defaultReasoningEffort"> & { supportedReasoningEfforts?: ReasoningEffort[]; defaultReasoningEffort?: ReasoningEffort };

// Preserve the application's event contract while replacing the execution harness.
export type AgentSession = Pick<CopilotSession, "sessionId" | "send" | "sendAndWait" | "abort" | "disconnect" | "getEvents" | "setModel"> & {
  readonly runtimeDisconnected?: boolean;
  on(handler: (event: SessionEvent) => void): () => void;
  /** 可选：引擎提供累计运行统计时订阅其更新。 */
  onRuntimeStats?(handler: (stats: RuntimeStats) => void): () => void;
  rpc: { history: Pick<CopilotSession["rpc"]["history"], "compact"> };
};
export interface AgentClient {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  createSession(config: SessionConfig): Promise<AgentSession>;
  resumeSession(id: string, config: ResumeSessionConfig): Promise<AgentSession>;
  deleteSession(id: string): Promise<void>;
  listModels(): Promise<AgentModelInfo[]>;
  /** 无工具的一次性文本生成（提交信息等）；不支持的引擎省略即可。 */
  generateText?(
    config: Pick<SessionConfig, "provider" | "model" | "systemMessage">,
    prompt: string,
    timeout: number,
  ): Promise<string>;
  rpc: Pick<CopilotClient["rpc"], "plugins">;
}
