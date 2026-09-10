import type { CopilotClient, CopilotSession, SessionConfig, ResumeSessionConfig, SessionEvent, ModelInfo } from "@github/copilot-sdk";

import type { ReasoningEffort } from "@cca/protocol";

export type AgentModelInfo = Omit<ModelInfo, "supportedReasoningEfforts" | "defaultReasoningEffort"> & { supportedReasoningEfforts?: ReasoningEffort[]; defaultReasoningEffort?: ReasoningEffort };

// Preserve the application's event contract while replacing the execution harness.
export type AgentSession = Pick<CopilotSession, "sessionId" | "send" | "sendAndWait" | "abort" | "disconnect" | "getEvents" | "setModel"> & {
  readonly runtimeDisconnected?: boolean;
  on(handler: (event: SessionEvent) => void): () => void;
  rpc: { history: Pick<CopilotSession["rpc"]["history"], "compact"> };
};
export interface AgentClient {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  createSession(config: SessionConfig): Promise<AgentSession>;
  resumeSession(id: string, config: ResumeSessionConfig): Promise<AgentSession>;
  deleteSession(id: string): Promise<void>;
  listModels(): Promise<AgentModelInfo[]>;
  rpc: Pick<CopilotClient["rpc"], "plugins">;
}
