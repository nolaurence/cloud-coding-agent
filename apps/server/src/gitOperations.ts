import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { devNull } from "node:os";
import { defineTool, type Tool } from "@github/copilot-sdk";
import type { GitCommitResult, GitProvider } from "@cca/protocol";
import { getGitCredential, type GitCredential } from "./gitBindings.js";

const GIT_TIMEOUT_MS = 2 * 60 * 1000;
const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
const MAX_COMMIT_MESSAGE_LENGTH = 2000;
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPOSITORY_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;

export type AuthenticatedGitAction = "clone" | "fetch" | "pull" | "push";

export interface AuthenticatedGitArgs {
  action: AuthenticatedGitAction;
  remote?: string;
  repository?: string;
  provider?: GitProvider;
  destination?: string;
  branch?: string;
  strategy?: "ff-only" | "rebase" | "merge";
  prune?: boolean;
  setUpstream?: boolean;
  forceWithLease?: boolean;
}

export interface NormalizedGitRemote {
  provider: GitProvider;
  url: string;
  authScope: string;
}

interface GitRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeout: number;
}

interface GitRunResult {
  stdout: string;
  stderr: string;
}

export type GitRunner = (args: string[], options: GitRunOptions) => Promise<GitRunResult>;

interface GitOperationDependencies {
  getCredential?: (ownerId: string, provider: GitProvider) => GitCredential | null;
  runGit?: GitRunner;
  baseEnv?: NodeJS.ProcessEnv;
}

export interface CommitProjectOptions {
  stageAll?: boolean;
}

function providerForHost(hostname: string): GitProvider | null {
  if (hostname === "github.com") return "github";
  if (hostname === "gitee.com") return "gitee";
  return null;
}

function validateRepositoryPath(value: string): string {
  const repositoryPath = value.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (
    !REPOSITORY_PATH.test(repositoryPath) ||
    repositoryPath.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error("仓库地址无效");
  }
  return `${repositoryPath}.git`;
}

export function normalizeGitRemote(
  input: string,
  shorthandProvider?: GitProvider,
): NormalizedGitRemote {
  const value = input.trim();
  if (!value || value.length > 2048 || value.includes("\0")) throw new Error("仓库地址无效");

  if (REPOSITORY_PATH.test(value.replace(/\.git$/i, ""))) {
    if (shorthandProvider !== "github" && shorthandProvider !== "gitee") {
      throw new Error("简写仓库地址需要指定 GitHub 或 Gitee");
    }
    const repositoryPath = validateRepositoryPath(value);
    const host = shorthandProvider === "github" ? "github.com" : "gitee.com";
    return {
      provider: shorthandProvider,
      url: `https://${host}/${repositoryPath}`,
      authScope: `https://${host}/`,
    };
  }

  const scpMatch = /^git@(github\.com|gitee\.com):(.+)$/.exec(value);
  if (scpMatch) {
    const host = scpMatch[1]!;
    const provider = providerForHost(host)!;
    return {
      provider,
      url: `https://${host}/${validateRepositoryPath(scpMatch[2]!)}`,
      authScope: `https://${host}/`,
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("仓库地址无效");
  }
  const provider = providerForHost(parsed.hostname.toLowerCase());
  if (!provider) throw new Error("仅支持 github.com 和 gitee.com 仓库");
  if (!["https:", "ssh:"].includes(parsed.protocol)) throw new Error("仓库地址仅支持 HTTPS 或 SSH");
  if (parsed.port || parsed.search || parsed.hash || parsed.password) throw new Error("仓库地址无效");
  if (parsed.protocol === "ssh:" && parsed.username && parsed.username !== "git") {
    throw new Error("SSH 仓库地址用户名无效");
  }
  if (parsed.protocol !== "ssh:" && parsed.username) throw new Error("仓库地址不能包含凭据");

  const host = provider === "github" ? "github.com" : "gitee.com";
  return {
    provider,
    url: `https://${host}/${validateRepositoryPath(parsed.pathname)}`,
    authScope: `https://${host}/`,
  };
}

function validateRemoteName(remote: string | undefined): string {
  const value = remote?.trim() || "origin";
  if (!REMOTE_NAME.test(value)) throw new Error("Git 远程名称无效");
  return value;
}

function validateBranch(branch: string | undefined): string | undefined {
  const value = branch?.trim();
  if (!value) return undefined;
  if (
    !GIT_REF.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".lock")
  ) {
    throw new Error("Git 分支或引用名称无效");
  }
  return value;
}

function resolveCloneDestination(cwd: string, destination: string | undefined, remoteUrl: string): string {
  const fallback = path.basename(new URL(remoteUrl).pathname).replace(/\.git$/i, "");
  const value = destination?.trim() || fallback;
  if (!value || value.length > 512 || value.includes("\0") || path.isAbsolute(value)) {
    throw new Error("克隆目标必须是项目目录内的相对路径");
  }
  const projectRoot = fs.realpathSync(cwd);
  const target = path.resolve(projectRoot, value);
  const relative = path.relative(projectRoot, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("克隆目标必须是项目目录内的子目录");
  }
  let realParent: string;
  try {
    realParent = fs.realpathSync(path.dirname(target));
  } catch {
    throw new Error("克隆目标的父目录不存在");
  }
  const parentRelative = path.relative(projectRoot, realParent);
  if (parentRelative === ".." || parentRelative.startsWith(`..${path.sep}`) || path.isAbsolute(parentRelative)) {
    throw new Error("克隆目标不能经过项目目录外的符号链接");
  }
  if (fs.existsSync(target)) {
    const realTarget = fs.realpathSync(target);
    const targetRelative = path.relative(projectRoot, realTarget);
    if (targetRelative === ".." || targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative)) {
      throw new Error("克隆目标不能指向项目目录外");
    }
  }
  return target;
}

function sanitizedGitEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (
      /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key) ||
      key === "GIT_ASKPASS" ||
      key === "SSH_ASKPASS" ||
      key === "GIT_CURL_VERBOSE" ||
      key.startsWith("GIT_TRACE") ||
      key.startsWith("GCM_TRACE")
    ) {
      delete env[key];
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export function buildAuthenticatedGitEnv(
  baseEnv: NodeJS.ProcessEnv,
  remote: NormalizedGitRemote,
  credential: GitCredential,
): NodeJS.ProcessEnv {
  const env = sanitizedGitEnv(baseEnv);
  const basic = Buffer.from(`${credential.username}:${credential.token}`, "utf8").toString("base64");
  env.GIT_CONFIG_COUNT = "3";
  env.GIT_CONFIG_KEY_0 = `http.${remote.authScope}.extraHeader`;
  env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  env.GIT_CONFIG_KEY_1 = "credential.helper";
  env.GIT_CONFIG_VALUE_1 = "";
  env.GIT_CONFIG_KEY_2 = "core.askPass";
  env.GIT_CONFIG_VALUE_2 = "";
  return env;
}

const defaultGitRunner: GitRunner = (args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        timeout: options.timeout,
        maxBuffer: MAX_GIT_OUTPUT,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

function redact(value: string, secrets: string[]): string {
  return secrets.reduce(
    (output, secret) => (secret ? output.replaceAll(secret, "[已隐藏]") : output),
    value,
  );
}

function commandError(error: unknown, prefix: string, secrets: string[] = []): Error {
  const detail =
    typeof (error as { stderr?: unknown })?.stderr === "string" &&
    (error as { stderr: string }).stderr.trim()
      ? (error as { stderr: string }).stderr.trim()
      : error instanceof Error
        ? error.message
        : String(error);
  return new Error(`${prefix}: ${redact(detail, secrets)}`);
}

function gitOptions(cwd: string, env: NodeJS.ProcessEnv): GitRunOptions {
  return { cwd, env, timeout: GIT_TIMEOUT_MS };
}

function outputFor(action: AuthenticatedGitAction, result: GitRunResult): string {
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return output || `git ${action} 已完成`;
}

export async function commitProjectChanges(
  cwd: string,
  message: string,
  options: CommitProjectOptions = {},
  dependencies: Pick<GitOperationDependencies, "runGit" | "baseEnv"> = {},
): Promise<GitCommitResult> {
  const normalizedMessage = typeof message === "string" ? message.trim() : "";
  if (!normalizedMessage) throw new Error("请输入提交说明");
  if (normalizedMessage.includes("\0")) throw new Error("提交说明包含无效字符");
  if (normalizedMessage.length > MAX_COMMIT_MESSAGE_LENGTH) {
    throw new Error(`提交说明不能超过 ${MAX_COMMIT_MESSAGE_LENGTH} 个字符`);
  }

  const runGit = dependencies.runGit ?? defaultGitRunner;
  const env = sanitizedGitEnv(dependencies.baseEnv ?? process.env);
  try {
    if (options.stageAll !== false) {
      await runGit(["add", "--all", "--"], gitOptions(cwd, env));
    }
    const staged = await runGit(["diff", "--cached", "--name-only", "-z"], gitOptions(cwd, env));
    if (!staged.stdout) throw new Error("没有可提交的更改");
    const commit = await runGit(
      ["-c", `core.hooksPath=${devNull}`, "commit", "-m", normalizedMessage],
      gitOptions(cwd, env),
    );
    const revision = await runGit(["rev-parse", "--short", "HEAD"], gitOptions(cwd, env));
    const hash = revision.stdout.trim();
    return { hash, summary: commit.stdout.trim() || `已创建提交 ${hash}` };
  } catch (error) {
    if (error instanceof Error && error.message === "没有可提交的更改") throw error;
    throw commandError(error, "Git 提交失败");
  }
}

export async function runAuthenticatedGit(
  ownerId: string,
  cwd: string,
  args: AuthenticatedGitArgs,
  dependencies: GitOperationDependencies = {},
): Promise<string> {
  if (!["clone", "fetch", "pull", "push"].includes(args.action)) {
    throw new Error("不支持的 Git 操作");
  }
  const runGit = dependencies.runGit ?? defaultGitRunner;
  const baseEnv = dependencies.baseEnv ?? process.env;
  const branch = validateBranch(args.branch);
  let remote: NormalizedGitRemote;
  let command: string[];
  let localCommand: string[] | undefined;
  let localCwd = cwd;

  if (args.action === "clone") {
    if (!args.repository) throw new Error("克隆仓库时必须提供仓库地址");
    remote = normalizeGitRemote(args.repository, args.provider);
    const destination = resolveCloneDestination(cwd, args.destination, remote.url);
    command = [
      "clone",
      "--no-checkout",
      ...(branch ? ["--branch", branch] : []),
      remote.url,
      destination,
    ];
    localCommand = ["checkout", "--force", branch ?? "HEAD"];
    localCwd = destination;
  } else {
    const remoteName = validateRemoteName(args.remote);
    let remoteResult: GitRunResult;
    try {
      remoteResult = await runGit(
        ["remote", "get-url", ...(args.action === "push" ? ["--push"] : []), remoteName],
        gitOptions(cwd, baseEnv),
      );
    } catch (error) {
      throw commandError(error, `无法读取远程仓库 ${remoteName}`);
    }
    const remoteUrl = remoteResult.stdout.trim();
    if (!remoteUrl) throw new Error(`远程仓库 ${remoteName} 没有可用地址`);
    remote = normalizeGitRemote(remoteUrl);

    // 注意:命令行的 -c remote.<name>.url 覆盖对已有远程不生效(git 会优先使用
    // 配置文件中的第一个值),因此这里通过 url.insteadOf 把 SSH 地址重写为 HTTPS,
    // 让注入的 HTTP 凭据对 fetch/pull/push 都生效。
    const overrides = ["-c", `url.${remote.url}.insteadOf=${remoteUrl}`];
    if (args.action === "push") {
      if (args.setUpstream && !branch) throw new Error("设置上游分支时必须提供分支名称");
      command = [
        ...overrides,
        "push",
        ...(args.forceWithLease ? ["--force-with-lease"] : []),
        ...(args.setUpstream ? ["--set-upstream"] : []),
        "--no-verify",
        remoteName,
        ...(branch ? [branch] : []),
      ];
    } else if (args.action === "pull") {
      const strategy = args.strategy ?? "ff-only";
      if (!["ff-only", "rebase", "merge"].includes(strategy)) throw new Error("不支持的 pull 策略");
      command = [...overrides, "fetch", remoteName, ...(branch ? [branch] : [])];
      localCommand =
        strategy === "rebase"
          ? ["rebase", "FETCH_HEAD"]
          : strategy === "merge"
            ? ["merge", "--no-edit", "FETCH_HEAD"]
            : ["merge", "--ff-only", "FETCH_HEAD"];
    } else {
      command = [
        ...overrides,
        "fetch",
        ...(args.prune ? ["--prune"] : []),
        remoteName,
        ...(branch ? [branch] : []),
      ];
    }
  }

  const getCredential = dependencies.getCredential ?? getGitCredential;
  const credential = getCredential(ownerId, remote.provider);
  if (!credential) {
    const label = remote.provider === "github" ? "GitHub" : "Gitee";
    throw new Error(`尚未绑定 ${label} 账号,请先在“设置 > 通用”中完成绑定`);
  }
  const env = buildAuthenticatedGitEnv(baseEnv, remote, credential);
  const encodedCredential = Buffer.from(`${credential.username}:${credential.token}`, "utf8").toString(
    "base64",
  );
  try {
    const authenticatedResult = await runGit(command, gitOptions(cwd, env));
    if (!localCommand) return outputFor(args.action, authenticatedResult);

    const localEnv = sanitizedGitEnv(baseEnv);
    localEnv.GIT_LFS_SKIP_SMUDGE = "1";
    const localResult = await runGit(localCommand, gitOptions(localCwd, localEnv));
    return outputFor(args.action, {
      stdout: [authenticatedResult.stdout.trim(), localResult.stdout.trim()].filter(Boolean).join("\n"),
      stderr: [authenticatedResult.stderr.trim(), localResult.stderr.trim()].filter(Boolean).join("\n"),
    });
  } catch (error) {
    throw commandError(error, `git ${args.action} 失败`, [credential.token, encodedCredential]);
  }
}

const TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["clone", "fetch", "pull", "push"] },
    remote: { type: "string", description: "远程名称,默认 origin" },
    repository: { type: "string", description: "clone 使用的 GitHub/Gitee 仓库地址或 owner/repo" },
    provider: { type: "string", enum: ["github", "gitee"], description: "仓库地址为 owner/repo 时必填" },
    destination: { type: "string", description: "clone 到当前项目目录下的相对路径" },
    branch: { type: "string", description: "分支名或引用;省略时使用当前分支/默认分支" },
    strategy: { type: "string", enum: ["ff-only", "rebase", "merge"], description: "pull 策略,默认 ff-only" },
    prune: { type: "boolean", description: "fetch 时清理已删除的远程引用" },
    setUpstream: { type: "boolean", description: "push 时设置上游分支" },
    forceWithLease: { type: "boolean", description: "push 时使用安全的 force-with-lease,仅在用户明确要求时启用" },
  },
} as const;

export function createAuthenticatedGitTool(ownerId: string | undefined, cwd: string): Tool<AuthenticatedGitArgs> {
  return defineTool<AuthenticatedGitArgs>("authenticated_git", {
    description:
      "使用当前用户在设置中绑定的 GitHub 或 Gitee 账号执行认证 Git 网络操作。对 clone、fetch、pull、push 优先使用此工具,不要索取或输出访问令牌。",
    parameters: TOOL_PARAMETERS,
    defer: "never",
    handler: async (args) => {
      if (!ownerId) throw new Error("旧会话没有关联用户,无法使用已绑定的代码托管账号");
      return runAuthenticatedGit(ownerId, cwd, args);
    },
  });
}
