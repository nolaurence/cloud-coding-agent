import type { PermissionHandler, PermissionRequestResult } from "@github/copilot-sdk";

const APPROVE: PermissionRequestResult = { kind: "approve-once" };

function reject(feedback: string): PermissionRequestResult {
  return { kind: "reject", feedback };
}

export function createWorkspacePermissionHandler(
  allowedMcpServers: ReadonlySet<string> = new Set(),
): PermissionHandler {
  return (request) => {
    if (request.kind === "mcp") {
      return allowedMcpServers.has(request.serverName)
        ? APPROVE
        : reject("MCP 服务器未在当前工作区启用：" + request.serverName);
    }
    if (request.kind === "custom-tool") {
      return ["authenticated_git", "manage_skills", "manage_mcp_servers"].includes(request.toolName)
        ? APPROVE
        : reject("工作区会话不允许执行未注册的自定义工具");
    }
    if (request.kind === "read" || request.kind === "write" || request.kind === "shell" || request.kind === "url") {
      return APPROVE;
    }
    return reject("当前功能未启用，已拒绝执行");
  };
}
