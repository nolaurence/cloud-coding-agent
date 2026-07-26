import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
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

export async function projectDiff(root: string): Promise<GitDiffResult> {
  let patch = "";
  try {
    const [unstaged, staged] = await Promise.all([
      execFileAsync("git", ["diff", "--no-ext-diff", "--no-color"], { cwd: root, maxBuffer: MAX_DIFF_SIZE * 2 }),
      execFileAsync("git", ["diff", "--cached", "--no-ext-diff", "--no-color"], { cwd: root, maxBuffer: MAX_DIFF_SIZE * 2 }),
    ]);
    patch = [staged.stdout, unstaged.stdout].filter(Boolean).join("\n");
  } catch (error) {
    throw new Error(error instanceof Error ? `读取 Git 差异失败：${error.message}` : "读取 Git 差异失败");
  }
  const additions = (patch.match(/^\+(?!\+\+)/gm) ?? []).length;
  const deletions = (patch.match(/^-(?!--)/gm) ?? []).length;
  const files = new Set([...patch.matchAll(/^diff --git a\/(.+?) b\//gm)].map((match) => match[1])).size;
  const truncated = patch.length > MAX_DIFF_SIZE;
  return { patch: truncated ? patch.slice(0, MAX_DIFF_SIZE) : patch, files, additions, deletions, truncated };
}
