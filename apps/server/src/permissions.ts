import fs from "node:fs";
import path from "node:path";
import type { PermissionHandler, PermissionRequestResult } from "@github/copilot-sdk";

const APPROVE: PermissionRequestResult = { kind: "approve-once" };

function reject(feedback: string): PermissionRequestResult {
  return { kind: "reject", feedback };
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function nearestExistingPath(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function isWorkspacePath(workspaceRoot: string, target: string): boolean {
  const absolute = path.resolve(workspaceRoot, target);
  if (!isInside(workspaceRoot, absolute)) return false;
  try {
    const existing = nearestExistingPath(absolute);
    return isInside(workspaceRoot, fs.realpathSync(existing));
  } catch {
    return false;
  }
}

export function createWorkspacePermissionHandler(
  workingDirectory: string,
  allowedMcpServers: ReadonlySet<string> = new Set(),
): PermissionHandler {
  const workspaceRoot = fs.realpathSync(workingDirectory);

  return (request) => {
    if ("requestSandboxBypass" in request && request.requestSandboxBypass) {
      return reject("不允许绕过工作区沙箱");
    }
    if (request.kind === "read") {
      return isWorkspacePath(workspaceRoot, request.path)
        ? APPROVE
        : reject("读取路径超出当前工作区：" + request.path);
    }
    if (request.kind === "write") {
      return isWorkspacePath(workspaceRoot, request.fileName)
        ? APPROVE
        : reject("写入路径超出当前工作区：" + request.fileName);
    }
    if (request.kind === "shell") {
      const targets = request.possiblePaths.length > 0 ? request.possiblePaths : [workspaceRoot];
      return targets.every((target) => isWorkspacePath(workspaceRoot, target))
        ? APPROVE
        : reject("命令访问了当前工作区外的路径：" + targets.join(", "));
    }
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
    if (request.kind === "url") return APPROVE;
    return reject("当前工具类型未启用工作区隔离，已拒绝执行");
  };
}
