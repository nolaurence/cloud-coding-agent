import fs from "node:fs";
import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SessionId, type SessionHeader } from "@deepseek-ai/dsh-session";
import * as JsonlPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";

const SESSION_ID = /^[A-Za-z0-9-]{1,100}$/;
const IDENTITY_FILE = /\.(json|jsonl)$/i;

function assertSessionId(id: string, label: string) {
  if (!SESSION_ID.test(id)) throw new Error(`${label}无效`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 只改独立的会话 id 片段，避免误伤更长的标识或普通文本。 */
export function rewriteSessionIdentityText(value: string, sourceId: string, destId: string): string {
  if (sourceId === destId) return value;
  if (value === sourceId) return destId;
  return value.replace(
    new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(sourceId)}(?![A-Za-z0-9-])`, "g"),
    destId,
  );
}

function rewriteIdentityValue(value: unknown, sourceId: string, destId: string): unknown {
  if (typeof value === "string") return rewriteSessionIdentityText(value, sourceId, destId);
  if (Array.isArray(value)) return value.map((item) => rewriteIdentityValue(item, sourceId, destId));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[rewriteSessionIdentityText(key, sourceId, destId)] = rewriteIdentityValue(
        item,
        sourceId,
        destId,
      );
    }
    return result;
  }
  return value;
}

function shouldCopyEntry(src: string): boolean {
  const name = path.basename(src);
  if (name.endsWith(".sock") || name.endsWith(".lock") || name === "lock") return false;
  try {
    const stat = fs.lstatSync(src);
    if (stat.isSocket() || stat.isFIFO()) return false;
  } catch {
    return false;
  }
  return true;
}

/** 复制引擎会话目录；源目录不存在时视为空会话，不创建目标。 */
export function copySessionHome(sourceHome: string, destHome: string) {
  if (!fs.existsSync(sourceHome)) return;
  if (path.resolve(sourceHome) === path.resolve(destHome)) {
    throw new Error("不能分叉到同一会话目录");
  }
  if (fs.existsSync(destHome)) throw new Error("目标会话已存在");
  fs.mkdirSync(path.dirname(destHome), { recursive: true, mode: 0o700 });
  fs.cpSync(sourceHome, destHome, {
    recursive: true,
    errorOnExist: true,
    filter: shouldCopyEntry,
  });
}

function renameIdentityEntry(name: string, sourceId: string, destId: string): string | null {
  if (name === sourceId) return destId;
  if (name.startsWith(`${sourceId}.`)) return destId + name.slice(sourceId.length);
  return null;
}

function renameIdentityPaths(root: string, sourceId: string, destId: string) {
  const pending: Array<{ from: string; to: string }> = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const from = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(from);
      const nextName = renameIdentityEntry(entry.name, sourceId, destId);
      if (nextName) pending.push({ from, to: path.join(dir, nextName) });
    }
  };
  walk(root);
  pending.sort((left, right) => right.from.length - left.from.length);
  for (const { from, to } of pending) {
    if (fs.existsSync(to)) throw new Error("目标会话已存在");
    fs.renameSync(from, to);
  }
}

function rewriteIdentityFile(file: string, sourceId: string, destId: string) {
  const raw = fs.readFileSync(file, "utf8");
  if (!raw.includes(sourceId)) return;
  if (file.endsWith(".jsonl")) {
    const next = raw.split("\n").map((line) => {
      if (!line || !line.includes(sourceId)) return line;
      try {
        return JSON.stringify(rewriteIdentityValue(JSON.parse(line), sourceId, destId));
      } catch {
        return rewriteSessionIdentityText(line, sourceId, destId);
      }
    });
    fs.writeFileSync(file, next.join("\n"), { mode: 0o600 });
    return;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    fs.writeFileSync(file, JSON.stringify(rewriteIdentityValue(parsed, sourceId, destId)), {
      mode: 0o600,
    });
  } catch {
    fs.writeFileSync(file, rewriteSessionIdentityText(raw, sourceId, destId), { mode: 0o600 });
  }
}

function rewriteIdentityFiles(root: string, sourceId: string, destId: string) {
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(target);
        continue;
      }
      if (!entry.isFile() || !IDENTITY_FILE.test(entry.name)) continue;
      rewriteIdentityFile(target, sourceId, destId);
    }
  };
  walk(root);
}

function rewriteMapping(home: string, destId: string) {
  const mapping = path.join(home, "cca-thread.json");
  if (!fs.existsSync(mapping)) return;
  try {
    const value = JSON.parse(fs.readFileSync(mapping, "utf8")) as { threadId?: unknown; cwd?: unknown };
    fs.writeFileSync(
      mapping,
      JSON.stringify({
        ...value,
        threadId: destId,
      }),
      { mode: 0o600 },
    );
  } catch {
    throw new Error("Harness 会话映射损坏，无法分叉");
  }
}

function removeNamedDirectories(root: string, name: string) {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name === name) fs.rmSync(target, { recursive: true, force: true });
    else removeNamedDirectories(target, name);
  }
}

function forkedSessionHeader(header: SessionHeader, destId: string): SessionHeader {
  return {
    version: header.version,
    id: SessionId(destId),
    createdAt: header.createdAt,
    isSeeded: false,
    ...(header.cwd ? { cwd: header.cwd } : {}),
    ...(header.origin ? { origin: header.origin } : {}),
    ...(header.delegationDepth !== undefined ? { delegationDepth: header.delegationDepth } : {}),
    ...(header.agentPreset ? { agentPreset: header.agentPreset } : {}),
  };
}

/**
 * 用 DSH 持久化 API 把原生会话复制到新 id（压缩 jsonl 不能靠改文件名续跑）。
 */
export async function forkDshNativeSession(home: string, sourceId: string, destId: string) {
  assertSessionId(sourceId, "源会话标识");
  assertSessionId(destId, "目标会话标识");
  if (sourceId === destId) throw new Error("不能分叉到同一会话");
  const sessionsRoot = path.join(home, "sessions");
  if (!fs.existsSync(sessionsRoot)) return;
  const ctx = new Context();
  await ctx.plugin(JsonlPersistence, { root: sessionsRoot });
  try {
    if (!(await ctx.sessionPersistence.stat(SessionId(sourceId)))) return;
    const reader = await ctx.sessionPersistence.open(SessionId(sourceId), "read");
    try {
      const { events } = await reader.read();
      const writer = await ctx.sessionPersistence.create(forkedSessionHeader(reader.header, destId));
      try {
        if (events.length > 0) {
          await writer.append(JSON.parse(JSON.stringify(events)) as typeof events);
        }
        await writer.flush();
      } finally {
        await writer.close();
      }
    } finally {
      await reader.close();
    }
  } finally {
    await ctx.fiber.dispose();
  }
  removeNamedDirectories(sessionsRoot, sourceId);
}

/**
 * DSH 把 CCA threadId 当作原生 sessionId 落盘。
 * 分叉后必须改写映射文件和投影缓存中的标识；原生会话由 forkDshNativeSession 复制。
 * 应用侧 cca-events.jsonl 保持原事件 id，与复制后的 thread_events 对齐。
 */
export function rewriteDshSessionIdentity(home: string, sourceId: string, destId: string) {
  assertSessionId(sourceId, "源会话标识");
  assertSessionId(destId, "目标会话标识");
  if (sourceId === destId) throw new Error("不能分叉到同一会话");
  if (!fs.existsSync(home)) return;
  rewriteMapping(home, destId);
  const storages = path.join(home, "storages");
  if (fs.existsSync(storages)) {
    renameIdentityPaths(storages, sourceId, destId);
    rewriteIdentityFiles(storages, sourceId, destId);
  }
}
