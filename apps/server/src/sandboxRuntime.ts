import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SANDBOX_ROOT = "/workspace";
export const SANDBOX_TIMEOUT_ERROR_CODE = "TIMEOUT";
export const SANDBOX_DIRECTORY_ERROR_CODE = "ENOENT";

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  errorCode?: string;
}

export interface SandboxExecErrorLike {
  killed?: boolean;
  signal?: NodeJS.Signals | string | null;
  code?: string | number | null;
  stdout?: string;
  stderr?: string;
  message?: string;
}

/** Map a session/host workspace path to the in-container `/workspace` cwd. */
export function mapSandboxCwd(
  cwd: string | undefined,
  hostWorkspace: string | undefined,
  sandboxRoot = SANDBOX_ROOT,
): { cwd: string; error?: string } {
  const root = posixNormalize(sandboxRoot || SANDBOX_ROOT);
  if (!cwd || !cwd.trim()) return { cwd: root };
  const requested = posixNormalize(cwd.replaceAll("\\", "/"));
  if (requested.includes("\0")) return { cwd: root, error: "cwd 无效" };

  const host = hostWorkspace ? posixNormalize(hostWorkspace.replaceAll("\\", "/")) : "";
  let mapped: string;
  // Host/session paths first: CCA workspaces often live under /workspace on the
  // server, which would otherwise look like an already-mapped sandbox cwd.
  if (host && (requested === host || requested.startsWith(host + "/"))) {
    mapped = posixNormalize(root + requested.slice(host.length));
  } else if (requested === root || requested.startsWith(root + "/")) {
    mapped = requested;
  } else if (!requested.startsWith("/")) {
    mapped = posixNormalize(root + "/" + requested);
  } else {
    mapped = requested;
  }

  if (mapped !== root && !mapped.startsWith(root + "/")) {
    return { cwd: mapped, error: `cwd 不在沙箱工作区内: ${cwd}` };
  }
  return { cwd: mapped };
}

function posixNormalize(value: string): string {
  const collapsed = path.posix.normalize(value);
  if (collapsed !== "/" && collapsed.endsWith("/")) return collapsed.slice(0, -1);
  return collapsed;
}

export function classifySandboxExecError(error: SandboxExecErrorLike): Pick<SandboxExecResult, "timedOut" | "errorCode" | "exitCode"> {
  const timedOut = error.killed === true || error.code === "ETIMEDOUT";
  if (timedOut) {
    return { timedOut: true, errorCode: SANDBOX_TIMEOUT_ERROR_CODE, exitCode: typeof error.code === "number" ? error.code : 1 };
  }
  return {
    timedOut: false,
    errorCode: typeof error.code === "string" ? error.code : undefined,
    exitCode: typeof error.code === "number" ? error.code : 1,
  };
}

export function missingDirectoryResult(cwd: string): SandboxExecResult {
  return {
    stdout: "",
    stderr: `directory does not exist: ${cwd}`,
    exitCode: 1,
    timedOut: false,
    errorCode: SANDBOX_DIRECTORY_ERROR_CODE,
  };
}

/** Host-side equivalent of the sandbox `tools.exec` result shape, for tests. */
export async function runMappedExec(
  command: string,
  options: { cwd?: string; timeoutMs?: number; hostWorkspace?: string; sandboxRoot?: string; shell?: string } = {},
): Promise<SandboxExecResult> {
  const mapped = mapSandboxCwd(options.cwd, options.hostWorkspace, options.sandboxRoot ?? process.cwd());
  if (mapped.error) {
    return { stdout: "", stderr: mapped.error, exitCode: 1, timedOut: false, errorCode: "EINVAL" };
  }
  try {
    const stat = await fs.stat(mapped.cwd);
    if (!stat.isDirectory()) {
      return { ...missingDirectoryResult(mapped.cwd), stderr: `cwd is not a directory: ${mapped.cwd}` };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") {
      return missingDirectoryResult(mapped.cwd);
    }
    throw error;
  }
  try {
    const result = await execFileAsync(options.shell ?? "/bin/bash", ["-lc", command], {
      cwd: mapped.cwd,
      timeout: options.timeoutMs,
      maxBuffer: 256 * 1024,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0, timedOut: false };
  } catch (error) {
    const failure = error as SandboxExecErrorLike;
    const classified = classifySandboxExecError(failure);
    return {
      stdout: failure.stdout || "",
      stderr: classified.errorCode === SANDBOX_DIRECTORY_ERROR_CODE
        ? missingDirectoryResult(mapped.cwd).stderr
        : (failure.stderr || failure.message || ""),
      exitCode: classified.exitCode,
      timedOut: classified.timedOut,
      errorCode: classified.errorCode,
    };
  }
}
