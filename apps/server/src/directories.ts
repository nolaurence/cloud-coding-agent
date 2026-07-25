import { promises as fs, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DirectoryBrowseResult } from "@cca/protocol";

const MAX_PATH_LENGTH = 4096;

function expandHome(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.resolve(os.homedir(), input.slice(2));
  }
  return input;
}

function readableDirectoryError(error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return new Error("目录不存在");
  if (code === "ENOTDIR") return new Error("路径不是目录");
  if (code === "EACCES" || code === "EPERM") return new Error("没有权限访问该目录");
  return new Error("无法读取目录");
}

function resolveAbsolutePath(input: string): string {
  const value = expandHome(input.trim());
  if (!value) throw new Error("请输入目录路径");
  if (value.length > MAX_PATH_LENGTH) throw new Error("目录路径过长");
  if (!path.isAbsolute(value)) throw new Error("请输入服务器上的绝对路径");
  return path.resolve(value);
}

export async function browseDirectories(partialPath: string): Promise<DirectoryBrowseResult> {
  const trimmedPath = partialPath.trim();
  const resolvedPath = resolveAbsolutePath(trimmedPath);
  const endsWithSeparator = /[\\/]$/.test(trimmedPath) || trimmedPath === "~";
  const parentPath = endsWithSeparator ? resolvedPath : path.dirname(resolvedPath);
  const prefix = endsWithSeparator ? "" : path.basename(resolvedPath);

  let entries: Dirent[];
  try {
    entries = await fs.readdir(parentPath, { withFileTypes: true });
  } catch (error) {
    throw readableDirectoryError(error);
  }

  const showHidden = endsWithSeparator || prefix.startsWith(".");
  const lowerPrefix = prefix.toLowerCase();
  return {
    parentPath,
    entries: entries
      .filter(
        (entry) =>
          entry.isDirectory() &&
          entry.name.toLowerCase().startsWith(lowerPrefix) &&
          (showHidden || !entry.name.startsWith(".")),
      )
      .map((entry) => ({ name: entry.name, fullPath: path.join(parentPath, entry.name) }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function resolveProjectDirectory(input: string): Promise<string> {
  const absolutePath = resolveAbsolutePath(input);
  let realPath: string;
  let stats;
  try {
    realPath = await fs.realpath(absolutePath);
    stats = await fs.stat(realPath);
  } catch (error) {
    throw readableDirectoryError(error);
  }
  if (!stats.isDirectory()) throw new Error("路径不是目录");
  return realPath;
}
