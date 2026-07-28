import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import type {
  GitDiffResult,
  ProjectDirectoryEntry,
  ProjectDirectoryListing,
  ProjectFileContent,
  ProjectFileEntry,
  ProjectFileWriteResult,
} from "@cca/protocol";

const execFileAsync = promisify(execFile);
const MAX_FILE_SIZE = 1024 * 1024;
const MAX_DIFF_SIZE = 2 * 1024 * 1024;
const MAX_UNTRACKED_FILES = 200;
const FILE_VERSION_PATTERN = /^[a-f0-9]{64}$/;
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".cache",
  ".next",
  ".pnpm-store",
  ".turbo",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

function canonicalRoot(root: string): string {
  return fs.realpathSync(root);
}

function resolveInside(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\0")) {
    throw new Error("文件路径无效");
  }
  const canonical = canonicalRoot(root);
  const target = fs.realpathSync(path.resolve(canonical, relativePath));
  if (target !== canonical && !target.startsWith(canonical + path.sep)) {
    throw new Error("文件不在项目目录内");
  }
  return target;
}

function projectPath(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

function contentVersion(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function decodeUtf8Text(buffer: Buffer, operation: "预览" | "保存"): string {
  if (buffer.includes(0)) throw new Error(`二进制文件无法${operation}`);
  const content = buffer.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(buffer)) {
    throw new Error(`非 UTF-8 文本无法${operation}`);
  }
  return content;
}

function encodeUtf8Text(content: unknown): Buffer {
  if (typeof content !== "string" || content.includes("\0")) {
    throw new Error("文件内容必须是 UTF-8 文本");
  }
  const encoded = Buffer.from(content, "utf8");
  if (encoded.toString("utf8") !== content) {
    throw new Error("文件内容包含无效的 Unicode 字符");
  }
  return encoded;
}

function sortedEntries(directory: string): fs.Dirent[] {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter(
      (entry) =>
        (entry.isFile() || entry.isDirectory()) &&
        !entry.isSymbolicLink() &&
        !(entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)),
    )
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) return left.isDirectory() ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
}

export function listProjectDirectory(root: string, relativePath = ""): ProjectDirectoryListing {
  const canonical = canonicalRoot(root);
  const directory = relativePath ? resolveInside(canonical, relativePath) : canonical;
  const directoryStat = fs.statSync(directory);
  if (!directoryStat.isDirectory()) throw new Error("目标不是目录");

  const entries: ProjectDirectoryEntry[] = [];
  for (const entry of sortedEntries(directory)) {
    const fullPath = path.join(directory, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }
    entries.push({
      name: entry.name,
      path: projectPath(canonical, fullPath),
      kind: entry.isDirectory() ? "directory" : "file",
      ...(entry.isFile() ? { size: stat.size } : {}),
      modifiedAt: stat.mtimeMs,
    });
  }

  return { path: projectPath(canonical, directory), entries };
}

export function listProjectFiles(root: string): ProjectFileEntry[] {
  const canonical = canonicalRoot(root);
  const entries: ProjectFileEntry[] = [];
  const walk = (directory: string, depth: number) => {
    if (depth > 12 || entries.length >= 5000) return;
    let children: fs.Dirent[];
    try {
      children = sortedEntries(directory);
    } catch (error) {
      if (directory === canonical) throw error;
      return;
    }
    for (const entry of children) {
      if (entries.length >= 5000) return;
      const fullPath = path.join(directory, entry.name);
      const relativePath = projectPath(canonical, fullPath);
      if (entry.isDirectory()) {
        entries.push({ path: relativePath, kind: "directory" });
        walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        entries.push({ path: relativePath, kind: "file" });
      }
    }
  };
  walk(canonical, 0);
  return entries;
}

export function readProjectFile(root: string, relativePath: string): ProjectFileContent {
  const canonical = canonicalRoot(root);
  const target = resolveInside(root, relativePath);
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error("目标不是文件");
  if (stat.size > MAX_FILE_SIZE) throw new Error("文件超过 1 MB，无法预览");
  const buffer = fs.readFileSync(target);
  const content = decodeUtf8Text(buffer, "预览");
  return {
    path: projectPath(canonical, target),
    content,
    size: stat.size,
    modifiedAt: stat.mtimeMs,
    version: contentVersion(buffer),
  };
}

export function writeProjectFile(
  root: string,
  relativePath: string,
  content: string,
  expectedVersion: string,
): ProjectFileWriteResult {
  const encoded = encodeUtf8Text(content);
  const size = encoded.length;
  if (size > MAX_FILE_SIZE) throw new Error("文件超过 1 MB，无法保存");
  if (typeof expectedVersion !== "string" || !FILE_VERSION_PATTERN.test(expectedVersion)) {
    throw new Error("文件版本无效，请重新加载后再编辑");
  }

  const canonical = canonicalRoot(root);
  const target = resolveInside(canonical, relativePath);
  const lexicalTarget = path.resolve(canonical, relativePath);
  const lexicalStat = fs.lstatSync(lexicalTarget);
  if (lexicalStat.isSymbolicLink()) throw new Error("不允许写入符号链接");

  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error("目标不是文件");
  if (stat.size > MAX_FILE_SIZE) throw new Error("文件超过 1 MB，无法保存");
  const current = fs.readFileSync(target);
  decodeUtf8Text(current, "保存");
  if (contentVersion(current) !== expectedVersion) {
    throw new Error("文件已被其他进程修改，请重新加载后再编辑");
  }

  fs.writeFileSync(target, encoded, { flag: "w" });
  const updated = fs.statSync(target);
  return {
    path: projectPath(canonical, target),
    size: updated.size,
    modifiedAt: updated.mtimeMs,
    version: contentVersion(encoded),
  };
}

interface GitStatusEntry {
  path: string;
  status: string;
}

function parseGitStatus(output: string): GitStatusEntry[] {
  const records = output.split("\0");
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    entries.push({ status, path: record.slice(3) });
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return entries;
}

function gitCommandError(error: unknown, operation: string): Error {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const detail =
    typeof stderr === "string" && stderr.trim()
      ? stderr.trim()
      : error instanceof Error
        ? error.message
        : String(error);
  return new Error(`${operation}失败：${detail}`);
}

async function gitHeadExists(root: string): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root });
    return true;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 1 || code === 128) return false;
    throw error;
  }
}

function patchPath(prefix: "a" | "b", relativePath: string): string {
  const value = `${prefix}/${relativePath}`;
  return /[\t\n\r"\\]/.test(value) ? JSON.stringify(value) : value;
}

function newTextFilePatch(root: string, relativePath: string): string | undefined {
  const canonical = canonicalRoot(root);
  const target = path.resolve(canonical, relativePath);
  if (target === canonical || !target.startsWith(canonical + path.sep)) return undefined;

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_SIZE) return undefined;

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (buffer.length > MAX_FILE_SIZE || buffer.includes(0)) return undefined;
  const content = buffer.toString("utf8");
  if (!Buffer.from(content, "utf8").equals(buffer)) return undefined;

  const mode = stat.mode & 0o111 ? "100755" : "100644";
  const oldPath = patchPath("a", relativePath);
  const newPath = patchPath("b", relativePath);
  const header = [
    `diff --git ${oldPath} ${newPath}`,
    `new file mode ${mode}`,
    "--- /dev/null",
    `+++ ${newPath}`,
  ];
  if (content.length === 0) return `${header.join("\n")}\n`;

  const lines = content.split("\n");
  const hasFinalNewline = content.endsWith("\n");
  if (hasFinalNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  return [
    ...header,
    `@@ -0,0 +1,${lines.length} @@`,
    body,
    ...(hasFinalNewline ? [] : ["\\ No newline at end of file"]),
    "",
  ].join("\n");
}

function appendPatch(current: string, addition: string): string {
  if (!current) return addition;
  return `${current.replace(/\n*$/, "")}\n${addition}`;
}

function trackedDiffPatch(root: string): Promise<{ patch: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["diff", "--no-ext-diff", "--no-color", "HEAD", "--"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let patch = "";
    let stderr = "";
    let truncated = false;
    let spawnError: Error | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const remaining = MAX_DIFF_SIZE - patch.length;
      if (remaining > 0) patch += chunk.slice(0, remaining);
      if (chunk.length > remaining) {
        truncated = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < 32_768) stderr += chunk.slice(0, 32_768 - stderr.length);
    });
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code) => {
      if (spawnError) {
        reject(spawnError);
        return;
      }
      if (truncated || code === 0) {
        resolve({ patch, truncated });
        return;
      }
      reject(Object.assign(new Error(`git diff 退出码 ${code ?? "未知"}`), { stderr }));
    });
  });
}

export async function projectDiff(root: string): Promise<GitDiffResult> {
  try {
    const [status, currentBranch, hasHead] = await Promise.all([
      execFileAsync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
        cwd: root,
        maxBuffer: MAX_DIFF_SIZE * 2,
      }),
      execFileAsync("git", ["branch", "--show-current"], { cwd: root }),
      gitHeadExists(root),
    ]);
    const statusEntries = parseGitStatus(status.stdout);
    const branch = currentBranch.stdout.trim() || undefined;
    const untrackedFiles = statusEntries
      .filter((entry) => entry.status === "??")
      .map((entry) => entry.path);

    let patch = "";
    let truncated = false;
    if (hasHead) {
      const tracked = await trackedDiffPatch(root);
      patch = tracked.patch;
      truncated = tracked.truncated;
    }

    const newFilePaths = hasHead
      ? untrackedFiles
      : statusEntries.map((entry) => entry.path);
    const renderablePaths = newFilePaths.slice(0, MAX_UNTRACKED_FILES);
    if (newFilePaths.length > renderablePaths.length) truncated = true;
    for (const relativePath of truncated ? [] : renderablePaths) {
      const filePatch = newTextFilePatch(root, relativePath);
      if (!filePatch) continue;
      const nextPatch = appendPatch(patch, filePatch);
      if (nextPatch.length > MAX_DIFF_SIZE) {
        truncated = true;
        break;
      }
      patch = nextPatch;
    }

    const additions = (patch.match(/^\+(?!\+\+)/gm) ?? []).length;
    const deletions = (patch.match(/^-(?!--)/gm) ?? []).length;
    if (patch.length > MAX_DIFF_SIZE) {
      patch = patch.slice(0, MAX_DIFF_SIZE);
      truncated = true;
    }
    return {
      patch,
      files: statusEntries.length,
      additions,
      deletions,
      truncated,
      branch,
      untracked: untrackedFiles.length,
      untrackedFiles: untrackedFiles.slice(0, MAX_UNTRACKED_FILES),
    };
  } catch (error) {
    throw gitCommandError(error, "读取 Git 差异");
  }
}

export async function projectGitPullTarget(root: string): Promise<{ remote: string; branch: string }> {
  try {
    const currentBranch = await execFileAsync("git", ["branch", "--show-current"], { cwd: root });
    const branch = currentBranch.stdout.trim();
    if (!branch) throw new Error("当前处于 detached HEAD，无法拉取分支");

    try {
      const upstream = await execFileAsync(
        "git",
        ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
        { cwd: root },
      );
      const value = upstream.stdout.trim();
      const separator = value.indexOf("/");
      if (separator > 0 && separator < value.length - 1) {
        return { remote: value.slice(0, separator), branch: value.slice(separator + 1) };
      }
    } catch {
      // 未配置上游时沿用 Git 的常见默认值 origin/<当前分支>。
    }
    return { remote: "origin", branch };
  } catch (error) {
    throw gitCommandError(error, "读取 Git 分支");
  }
}
