import type { CopilotClient } from "@github/copilot-sdk";

/**
 * Per-session sandbox config in the runtime RPC shape
 * (`SandboxConfig` in schemas/api.schema.json). The SDK's SessionConfig does
 * not expose a sandbox field and silently drops unknown keys, so this is
 * injected into session.create/session.resume RPC params directly.
 */
export interface WorkspaceSandboxConfig {
  enabled: boolean;
  addCurrentWorkingDirectory: boolean;
  userPolicy: {
    filesystem: {
      readwritePaths: string[];
      deniedPaths: string[];
    };
  };
}

export function buildWorkspaceSandboxConfig(
  workspacePath: string,
  deniedPaths: readonly string[],
): WorkspaceSandboxConfig {
  return {
    enabled: true,
    addCurrentWorkingDirectory: true,
    userPolicy: {
      filesystem: {
        readwritePaths: [workspacePath],
        deniedPaths: [...new Set(deniedPaths.filter((p) => p !== workspacePath))],
      },
    },
  };
}

const SESSION_METHODS = new Set(["session.create", "session.resume"]);

type SendRequest = (method: string, params?: unknown) => Promise<unknown>;

/**
 * Wraps the client's JSON-RPC connection so every session is created with a
 * sandbox policy keyed off its workingDirectory (the workspace path).
 * `client.connection` is a runtime-accessible SDK internal; fail loudly if the
 * SDK layout changes so sandboxing is never silently skipped.
 */
export function installWorkspaceSandbox(
  client: CopilotClient,
  resolveDeniedPaths: (workspacePath: string) => readonly string[],
): void {
  const connection = (client as unknown as { connection?: { sendRequest?: unknown } }).connection;
  if (!connection || typeof connection.sendRequest !== "function") {
    throw new Error("Copilot SDK 连接不可用,无法启用工作区沙箱");
  }
  const original = connection.sendRequest as SendRequest;
  connection.sendRequest = (method: string, params?: unknown) => {
    if (SESSION_METHODS.has(method) && params && typeof params === "object") {
      const wire = params as Record<string, unknown>;
      const workspacePath = wire.workingDirectory;
      if (typeof workspacePath === "string" && workspacePath && wire.sandboxConfig === undefined) {
        wire.sandboxConfig = buildWorkspaceSandboxConfig(
          workspacePath,
          resolveDeniedPaths(workspacePath),
        );
      }
    }
    return original.call(connection, method, params);
  };
}
