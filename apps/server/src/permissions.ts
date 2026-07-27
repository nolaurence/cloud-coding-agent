import path from "node:path";
import type { PermissionHandler, PermissionRequestResult } from "@github/copilot-sdk";

const WRITABLE_ROOTS = ["/projects", "/workspace"];

function isWritablePath(target: string, workingDirectory: string): boolean {
  const absolute = path.resolve(workingDirectory, target);
  return WRITABLE_ROOTS.some(
    (root) => absolute === root || absolute.startsWith(root + path.sep),
  );
}

const APPROVE: PermissionRequestResult = { kind: "approve-once" };

function reject(feedback: string): PermissionRequestResult {
  return { kind: "reject", feedback };
}

const RULE_HINT = "仅 /projects 和 /workspace 可读写,其他目录只读";

export function createWorkspacePermissionHandler(
  workingDirectory: string,
): PermissionHandler {
  return (request) => {
    if (request.kind === "write") {
      return isWritablePath(request.fileName, workingDirectory)
        ? APPROVE
        : reject(`写入路径超出可写范围(${RULE_HINT}):${request.fileName}`);
    }

    if (request.kind === "shell") {
      if (request.requestSandboxBypass) {
        return reject(`不允许请求沙箱外执行(${RULE_HINT})`);
      }
      const mutating =
        request.hasWriteFileRedirection ||
        request.commands.some((command) => !command.readOnly);
      if (!mutating) return APPROVE;
      // 无法解析出路径时按工作目录判定(例如 npm test 这类在项目内执行的命令)
      const targets =
        request.possiblePaths.length > 0
          ? request.possiblePaths
          : [workingDirectory];
      return targets.every((target) => isWritablePath(target, workingDirectory))
        ? APPROVE
        : reject(`命令涉及可写范围外的路径(${RULE_HINT}):${targets.join(", ")}`);
    }

    // 读、MCP、URL 等其他请求保持放行
    return APPROVE;
  };
}
