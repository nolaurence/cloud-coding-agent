import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  GitDiffResult,
  ProjectDirectoryEntry,
  ProjectDirectoryListing,
  ProjectFileContent,
  ProjectFileEntry,
} from "@cca/protocol";

const execFileAsync = promisify(execFile);
const MAX_FILE_SIZE = 1024 * 1024;
const MAX_DIFF_SIZE = 2 * 1024 * 1024;
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
  if (buffer.includes(0)) throw new Error("二进制文件无法预览");
  return { path: projectPath(canonical, target), content: buffer.toString("utf8"), size: stat.size };
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
