import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  GitFileChange,
  GitFileDiffResult,
  GitFileStatus,
  GitLogCommit,
  GitLogResult,
  GitWorkspaceStatus,
} from "@cca/protocol";

const GIT_TIMEOUT_MS = 60_000;
const MAX_GIT_OUTPUT = 2 * 1024 * 1024;
const MAX_PATHS = 200;
const MAX_PATH_LENGTH = 4096;
const MAX_PATH_ARGUMENT_LENGTH = 24_000;
const MAX_QUERY_LENGTH = 200;
const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 200;
const projectMutationTails = new Map<string, Promise<unknown>>();

interface GitResult {
  stdout: string;
  stderr: string;
  truncated: boolean;
}

interface GitCommandError extends Error {
  code?: string | number | null;
  stdout?: string;
  stderr?: string;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(key) ||
      [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_COMMON_DIR",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_EXTERNAL_DIFF",
        "GIT_DIFF_OPTS",
        "GIT_ASKPASS",
        "SSH_ASKPASS",
      ].includes(key)
    ) {
      delete env[key];
    }
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.LC_ALL = "C";
  return env;
}

function trimUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return { value, truncated: false };

  let end = maxBytes;
  while (end > 0 && (encoded[end] ?? 0) >= 0x80 && (encoded[end] ?? 0) < 0xc0) end -= 1;
  return { value: encoded.subarray(0, end).toString("utf8"), truncated: true };
}

function isStdoutOverflow(error: GitCommandError): boolean {
  return (
    error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" &&
    /stdout maxBuffer/i.test(error.message)
  );
}

function gitError(error: unknown, operation: string): Error {
  const candidate = error as GitCommandError;
  const detail =
    typeof candidate.stderr === "string" && candidate.stderr.trim()
      ? candidate.stderr.trim()
      : error instanceof Error
        ? error.message
        : String(error);
  return new Error(`${operation}失败：${detail.slice(0, 32_768)}`);
}

function runGit(
  root: string,
  args: string[],
  options: { allowTruncatedStdout?: boolean; maxOutput?: number } = {},
): Promise<GitResult> {
  const maxOutput = options.maxOutput ?? MAX_GIT_OUTPUT;
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: root,
        env: gitEnvironment(),
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: maxOutput + 1,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const limited = trimUtf8(stdout, maxOutput);
        if (error) {
          const commandError = Object.assign(error, { stdout, stderr });
          if (options.allowTruncatedStdout && isStdoutOverflow(commandError)) {
            resolve({ stdout: limited.value, stderr, truncated: true });
            return;
          }
          reject(commandError);
          return;
        }
        resolve({ stdout: limited.value, stderr, truncated: limited.truncated });
      },
    );
  });
}

export async function withProjectGitMutation<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const key = fs.realpathSync(root);
  const previous = projectMutationTails.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  projectMutationTails.set(key, current);
  try {
    return await current;
  } finally {
    if (projectMutationTails.get(key) === current) projectMutationTails.delete(key);
  }
}

function validateGitPath(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > MAX_PATH_LENGTH || value.includes("\0")) {
    throw new Error("Git 文件路径无效");
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Git 文件路径必须是工作区内的相对路径");
  }
  return normalized;
}

function validatePathArray(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS) {
    throw new Error(`每次必须选择 1 到 ${MAX_PATHS} 个文件`);
  }
  const unique = [...new Set(paths.map(validateGitPath))];
  if (unique.reduce((length, filePath) => length + filePath.length + 1, 0) > MAX_PATH_ARGUMENT_LENGTH) {
    throw new Error("所选 Git 文件路径总长度过大");
  }
  return unique;
}

function validateExpandedPaths(paths: string[]): string[] {
  const unique = [...new Set(paths)];
  if (
    unique.length > MAX_PATHS * 2 ||
    unique.reduce((length, filePath) => length + filePath.length + 1, 0) > MAX_PATH_ARGUMENT_LENGTH
  ) {
    throw new Error("所选 Git 文件路径总长度过大");
  }
  return unique;
}

function fileStatus(code: string): GitFileStatus | undefined {
  if (code === "." || code === " ") return undefined;
  if (code === "T") return "M";
  if (["M", "A", "D", "R", "C", "U", "?"].includes(code)) {
    return code as GitFileStatus;
  }
  return "U";
}

function addStatusChange(
  changes: Map<string, GitFileChange>,
  pathValue: string,
  xy: string,
  oldPath?: string,
  unmerged = false,
) {
  const existing = changes.get(pathValue) ?? { path: pathValue };
  const staged = unmerged ? "U" : fileStatus(xy[0] ?? ".");
  const unstaged = unmerged ? "U" : fileStatus(xy[1] ?? ".");
  if (oldPath) existing.oldPath = oldPath;
  if (staged) existing.staged = staged;
  if (unstaged) existing.unstaged = unstaged;
  changes.set(pathValue, existing);
}

export function parseProjectGitStatus(
  output: string,
  head: string | null = null,
  indexTree = "",
): GitWorkspaceStatus {
  const records = output.split("\0");
  const changes = new Map<string, GitFileChange>();
  let branch: string | undefined;
  let detached = false;
  let upstream: string | undefined;
  let ahead = 0;
  let behind = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    if (record.startsWith("# branch.head ")) {
      const value = record.slice("# branch.head ".length);
      detached = value === "(detached)";
      branch = detached ? undefined : value;
      continue;
    }
    if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length) || undefined;
      continue;
    }
    if (record.startsWith("# branch.ab ")) {
      const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }

    const fields = record.split(" ");
    if (fields[0] === "1" && fields.length >= 9) {
      addStatusChange(changes, fields.slice(8).join(" "), fields[1] ?? "..");
    } else if (fields[0] === "2" && fields.length >= 10) {
      const oldPath = records[index + 1];
      if (oldPath !== undefined) index += 1;
      addStatusChange(changes, fields.slice(9).join(" "), fields[1] ?? "..", oldPath || undefined);
    } else if (fields[0] === "u" && fields.length >= 11) {
      addStatusChange(changes, fields.slice(10).join(" "), fields[1] ?? "UU", undefined, true);
    } else if (record.startsWith("? ")) {
      addStatusChange(changes, record.slice(2), ".?");
    }
  }

  return { head, indexTree, branch, detached, upstream, ahead, behind, files: [...changes.values()] };
}

async function projectGitHead(root: string): Promise<string | null> {
  try {
    const result = await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return result.stdout.trim() || null;
  } catch (error) {
    const code = (error as GitCommandError).code;
    if (code === 1 || code === 128) return null;
    throw error;
  }
}

async function projectGitIndexTree(root: string): Promise<string> {
  try {
    const result = await runGit(root, ["write-tree"]);
    return result.stdout.trim();
  } catch {
    // write-tree rejects an unmerged index. The staged entries still provide a stable opaque token.
    const result = await runGit(root, ["ls-files", "--stage", "-z"]);
    return `unmerged:${createHash("sha256").update(result.stdout).digest("hex")}`;
  }
}

async function projectGitVersion(root: string): Promise<{ head: string | null; indexTree: string }> {
  const [head, indexTree] = await Promise.all([projectGitHead(root), projectGitIndexTree(root)]);
  return { head, indexTree };
}

async function readProjectGitStatus(root: string): Promise<GitWorkspaceStatus> {
  try {
    const [result, version] = await Promise.all([
      runGit(root, [
        "-c",
        "status.renames=copies",
        "status",
        "--porcelain=v2",
        "--branch",
        "-z",
        "--untracked-files=all",
      ]),
      projectGitVersion(root),
    ]);
    if (result.truncated) throw new Error("Git 状态输出超过 2 MB");
    return parseProjectGitStatus(result.stdout, version.head, version.indexTree);
  } catch (error) {
    if (error instanceof Error && error.message === "Git 状态输出超过 2 MB") throw error;
    throw gitError(error, "读取 Git 状态");
  }
}

export function projectGitStatus(root: string): Promise<GitWorkspaceStatus> {
  return withProjectGitMutation(root, () => readProjectGitStatus(root));
}

function validateLogOptions(limitValue: number | undefined, queryValue: string | undefined) {
  const limit = limitValue ?? DEFAULT_LOG_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_LIMIT) {
    throw new Error(`Git 日志条数必须是 1 到 ${MAX_LOG_LIMIT} 之间的整数`);
  }
  if (queryValue !== undefined && typeof queryValue !== "string") {
    throw new Error("Git 日志搜索内容无效");
  }
  if (queryValue?.includes("\0") || (queryValue?.length ?? 0) > MAX_QUERY_LENGTH) {
    throw new Error(`Git 日志搜索内容不能超过 ${MAX_QUERY_LENGTH} 个字符`);
  }
  const query = queryValue?.trim() || undefined;
  return { limit, query };
}

function parseLogRecord(record: string): GitLogCommit | undefined {
  const normalized = record.replace(/^\r?\n/, "");
  if (!normalized) return undefined;
  const fields = normalized.split("\0");
  if (fields.length < 8) throw new Error("Git 日志输出格式无效");
  const [hash, shortHash, parentsValue, author, email, timestamp, subject, refsValue] = fields;
  const seconds = Number(timestamp);
  if (!hash || !shortHash || !Number.isFinite(seconds)) throw new Error("Git 日志输出格式无效");
  return {
    hash,
    shortHash,
    parents: parentsValue ? parentsValue.split(" ").filter(Boolean) : [],
    author: author ?? "",
    email: email ?? "",
    date: seconds * 1000,
    subject: subject ?? "",
    refs: refsValue ? refsValue.split(", ").filter(Boolean) : [],
  };
}

export async function projectGitLog(
  root: string,
  options: { limit?: number; query?: string } = {},
): Promise<GitLogResult> {
  const { limit, query } = validateLogOptions(options.limit, options.query);
  const format = "%x1e%H%x00%h%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%D%x00";
  const args = [
    "log",
    "--topo-order",
    `--max-count=${limit + 1}`,
    `--format=format:${format}`,
    "--decorate=short",
    ...(query ? ["--fixed-strings", "--regexp-ignore-case", `--grep=${query}`] : []),
    "HEAD",
    "--",
  ];

  try {
    const head = await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (!head.stdout.trim()) return { commits: [], hasMore: false };
    const result = await runGit(root, args);
    if (result.truncated) throw new Error("Git 日志输出超过 2 MB");
    const commits = result.stdout
      .split("\x1e")
      .map(parseLogRecord)
      .filter((commit): commit is GitLogCommit => commit !== undefined);
    return { commits: commits.slice(0, limit), hasMore: commits.length > limit };
  } catch (error) {
    const code = (error as GitCommandError).code;
    if (code === 1 || code === 128) {
      const stderr = (error as GitCommandError).stderr ?? "";
      if (!stderr.trim() || /unknown revision|bad revision|does not have any commits/i.test(stderr)) {
        return { commits: [], hasMore: false };
      }
    }
    if (error instanceof Error && error.message === "Git 日志输出超过 2 MB") throw error;
    throw gitError(error, "读取 Git 日志");
  }
}

function displayPatchPath(prefix: "a" | "b", relativePath: string): string {
  const value = `${prefix}/${relativePath}`;
  return /[\t\n\r"\\]/.test(value) ? JSON.stringify(value) : value;
}

function untrackedFilePatch(root: string, relativePath: string): { patch: string; truncated: boolean } {
  const canonicalRoot = fs.realpathSync(root);
  const target = path.resolve(canonicalRoot, ...relativePath.split("/"));
  if (target === canonicalRoot || !target.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error("Git 文件路径必须是工作区内的相对路径");
  }
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) return { patch: "", truncated: false };
  if (stat.size > MAX_GIT_OUTPUT) return { patch: "", truncated: true };

  const buffer = fs.readFileSync(target);
  const oldPath = displayPatchPath("a", relativePath);
  const newPath = displayPatchPath("b", relativePath);
  const mode = stat.mode & 0o111 ? "100755" : "100644";
  const header = `diff --git ${oldPath} ${newPath}\nnew file mode ${mode}\n`;
  if (buffer.includes(0)) {
    return { patch: `${header}Binary files /dev/null and ${newPath} differ\n`, truncated: false };
  }

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return { patch: `${header}Binary files /dev/null and ${newPath} differ\n`, truncated: false };
  }
  const lines = content.split("\n");
  const hasFinalNewline = content.endsWith("\n");
  if (hasFinalNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const patch = [
    header.trimEnd(),
    "--- /dev/null",
    `+++ ${newPath}`,
    ...(content ? [`@@ -0,0 +1,${lines.length} @@`, body] : []),
    ...(!content || hasFinalNewline ? [] : ["\\ No newline at end of file"]),
    "",
  ].join("\n");
  const limited = trimUtf8(patch, MAX_GIT_OUTPUT);
  return { patch: limited.value, truncated: limited.truncated };
}

export async function projectGitFileDiff(
  root: string,
  filePath: string,
  staged: boolean,
): Promise<GitFileDiffResult> {
  const relativePath = validateGitPath(filePath);
  if (typeof staged !== "boolean") throw new Error("Git 差异类型无效");

  try {
    const result = await runGit(
      root,
      [
        "--literal-pathspecs",
        "diff",
        ...(staged ? ["--cached"] : []),
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--",
        relativePath,
      ],
      { allowTruncatedStdout: true },
    );
    if (staged || result.stdout || result.truncated) {
      return { path: relativePath, staged, patch: result.stdout, truncated: result.truncated };
    }

    const untracked = await runGit(root, [
      "--literal-pathspecs",
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      relativePath,
    ]);
    if (!untracked.stdout.split("\0").includes(relativePath)) {
      return { path: relativePath, staged, patch: "", truncated: false };
    }
    const generated = untrackedFilePatch(root, relativePath);
    return { path: relativePath, staged, ...generated };
  } catch (error) {
    throw gitError(error, "读取 Git 文件差异");
  }
}

async function expandRenamePaths(root: string, requestedPaths: string[]): Promise<string[]> {
  const requested = new Set(requestedPaths);
  const status = await readProjectGitStatus(root);
  const expanded = [...requestedPaths];
  for (const change of status.files) {
    if (!change.oldPath) continue;
    if (requested.has(change.path) || requested.has(change.oldPath)) {
      expanded.push(change.path, change.oldPath);
    }
  }
  return validateExpandedPaths(expanded);
}

export interface ExpectedGitWorkspaceVersion {
  expectedHead: string | null;
  expectedIndexTree: string;
}

function validateExpectedVersion(expected: ExpectedGitWorkspaceVersion) {
  if (
    (expected.expectedHead !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(expected.expectedHead)) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64}|unmerged:[a-f0-9]{64})$/i.test(expected.expectedIndexTree)
  ) {
    throw new Error("Git 工作区版本无效，请刷新后重试");
  }
}

export async function assertProjectGitVersion(
  root: string,
  expected: ExpectedGitWorkspaceVersion,
): Promise<void> {
  validateExpectedVersion(expected);
  const current = await projectGitVersion(root);
  if (current.head !== expected.expectedHead || current.indexTree !== expected.expectedIndexTree) {
    throw new Error("Git 工作区已发生变化，请刷新后重试");
  }
}

export async function stageProjectFiles(
  root: string,
  paths: string[],
  expected?: ExpectedGitWorkspaceVersion,
): Promise<void> {
  const selectedPaths = validatePathArray(paths);
  await withProjectGitMutation(root, async () => {
    try {
      if (expected) await assertProjectGitVersion(root, expected);
      const expanded = await expandRenamePaths(root, selectedPaths);
      await runGit(root, ["--literal-pathspecs", "add", "--all", "--", ...expanded]);
    } catch (error) {
      throw gitError(error, "暂存 Git 文件");
    }
  });
}

async function repositoryHasHead(root: string): Promise<boolean> {
  try {
    const result = await runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return Boolean(result.stdout.trim());
  } catch (error) {
    const code = (error as GitCommandError).code;
    if (code === 1 || code === 128) return false;
    throw error;
  }
}

export async function unstageProjectFiles(
  root: string,
  paths: string[],
  expected?: ExpectedGitWorkspaceVersion,
): Promise<void> {
  const selectedPaths = validatePathArray(paths);
  await withProjectGitMutation(root, async () => {
    try {
      if (expected) await assertProjectGitVersion(root, expected);
      const expanded = await expandRenamePaths(root, selectedPaths);
      if (await repositoryHasHead(root)) {
        await runGit(root, ["--literal-pathspecs", "reset", "--quiet", "HEAD", "--", ...expanded]);
      } else {
        await runGit(root, [
          "--literal-pathspecs",
          "rm",
          "--cached",
          "--ignore-unmatch",
          "-r",
          "--",
          ...expanded,
        ]);
      }
    } catch (error) {
      throw gitError(error, "取消暂存 Git 文件");
    }
  });
}

export async function projectGitPushTarget(
  root: string,
): Promise<{ remote: string; branch: string; setUpstream: boolean }> {
  try {
    const branchResult = await runGit(root, ["branch", "--show-current"]);
    const branch = branchResult.stdout.trim();
    if (!branch) throw new Error("当前处于 detached HEAD，无法推送分支");

    try {
      const upstreamResult = await runGit(root, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ]);
      const upstream = upstreamResult.stdout.trim();
      const separator = upstream.indexOf("/");
      if (separator > 0) {
        return { remote: upstream.slice(0, separator), branch, setUpstream: false };
      }
    } catch {
      // A branch without an upstream is pushed to origin and configured in one operation.
    }
    return { remote: "origin", branch, setUpstream: true };
  } catch (error) {
    if (error instanceof Error && /detached HEAD/.test(error.message)) throw error;
    throw gitError(error, "读取 Git 推送目标");
  }
}
