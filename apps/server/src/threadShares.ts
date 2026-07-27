import crypto from "node:crypto";
import fs from "node:fs";
import type { CreatedThreadShare, ThreadShareMode, ThreadShareSummary } from "@cca/protocol";
import { THREAD_SHARES_FILE } from "./env.js";
import { query, transaction, upsert, usingDatabase } from "./db.js";

interface ThreadShareRecord {
  threadId: string;
  mode: ThreadShareMode;
  tokenHash: string;
  createdBy: string;
  createdAt: number;
  members: Record<string, number>;
}

let shares = new Map<string, ThreadShareRecord>();
let mutationQueue: Promise<void> = Promise.resolve();

function parseJson<T>(value: unknown): T {
  const normalized = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  return (typeof normalized === "string" ? JSON.parse(normalized) : normalized) as T;
}

function parseStoredShare(value: unknown): ThreadShareRecord | null {
  try {
    return normalizeShare(parseJson<unknown>(value));
  } catch {
    return null;
  }
}

function enqueueMutation<T>(task: () => Promise<T>): Promise<T> {
  const result = mutationQueue.then(task, task);
  mutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function normalizeShare(value: unknown): ThreadShareRecord | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.threadId !== "string" ||
    !candidate.threadId ||
    (candidate.mode !== "readonly" && candidate.mode !== "collaborate") ||
    typeof candidate.tokenHash !== "string" ||
    !/^[a-f\d]{64}$/i.test(candidate.tokenHash) ||
    typeof candidate.createdBy !== "string" ||
    typeof candidate.createdAt !== "number" ||
    !Number.isFinite(candidate.createdAt)
  ) {
    return null;
  }

  const members: Record<string, number> = Object.create(null) as Record<string, number>;
  if (candidate.members && typeof candidate.members === "object" && !Array.isArray(candidate.members)) {
    for (const [username, joinedAt] of Object.entries(candidate.members)) {
      if (typeof joinedAt === "number" && Number.isFinite(joinedAt)) members[username] = joinedAt;
    }
  }
  return {
    threadId: candidate.threadId,
    mode: candidate.mode,
    tokenHash: candidate.tokenHash.toLowerCase(),
    createdBy: candidate.createdBy,
    createdAt: candidate.createdAt,
    members,
  };
}

function loadJson(): ThreadShareRecord[] {
  try {
    if (!fs.existsSync(THREAD_SHARES_FILE)) return [];
    const value = JSON.parse(fs.readFileSync(THREAD_SHARES_FILE, "utf8")) as unknown;
    return Array.isArray(value)
      ? value.map(normalizeShare).filter((share): share is ThreadShareRecord => share !== null)
      : [];
  } catch {
    return [];
  }
}

function saveJson(): void {
  const target = `${THREAD_SHARES_FILE}.tmp`;
  fs.writeFileSync(target, JSON.stringify([...shares.values()], null, 2), "utf8");
  fs.renameSync(target, THREAD_SHARES_FILE);
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function persistShare(share: ThreadShareRecord): Promise<void> {
  if (usingDatabase()) {
    await upsert({
      table: "thread_shares",
      values: { thread_id: share.threadId, data: JSON.stringify(share) },
      conflictColumns: ["thread_id"],
      updateColumns: ["data"],
    });
  } else {
    saveJson();
  }
}

async function removePersistedShare(threadId: string): Promise<void> {
  if (usingDatabase()) await query("DELETE FROM thread_shares WHERE thread_id = ?", [threadId]);
  else saveJson();
}

function summary(share: ThreadShareRecord | undefined): ThreadShareSummary {
  if (!share) return { active: false, memberCount: 0 };
  return {
    active: true,
    mode: share.mode,
    createdAt: share.createdAt,
    memberCount: Object.keys(share.members).length,
  };
}

function hasMember(share: ThreadShareRecord, username: string): boolean {
  return Object.prototype.hasOwnProperty.call(share.members, username);
}

export async function initThreadShares(): Promise<void> {
  shares = new Map();
  if (!usingDatabase()) {
    shares = new Map(loadJson().map((share) => [share.threadId, share]));
    return;
  }

  const rows = await query<{ thread_id: string; data: unknown }>(
    "SELECT thread_id, data FROM thread_shares",
  );
  if (rows.rows.length > 0) {
    const loaded = rows.rows
      .map((row) => parseStoredShare(row.data))
      .filter((share): share is ThreadShareRecord => share !== null);
    shares = new Map(loaded.map((share) => [share.threadId, share]));
    return;
  }

  const jsonShares = loadJson();
  if (jsonShares.length === 0) return;
  await transaction(async (txQuery) => {
    for (const share of jsonShares) {
      await upsert(
        {
          table: "thread_shares",
          values: { thread_id: share.threadId, data: JSON.stringify(share) },
          conflictColumns: ["thread_id"],
        },
        txQuery,
      );
    }
  });
  shares = new Map(jsonShares.map((share) => [share.threadId, share]));
}

export function getThreadShare(threadId: string): ThreadShareSummary {
  return summary(shares.get(threadId));
}

export function getSharedThreadAccess(
  threadId: string,
  username: string,
): ThreadShareMode | null {
  const share = shares.get(threadId);
  if (!share || !hasMember(share, username)) return null;
  return share.mode;
}

export function inspectThreadShare(
  token: string,
): { threadId: string; mode: ThreadShareMode } | null {
  const normalized = token.trim();
  if (!normalized) return null;
  const digest = hashToken(normalized);
  const share = [...shares.values()].find((candidate) =>
    hashesEqual(candidate.tokenHash, digest),
  );
  return share ? { threadId: share.threadId, mode: share.mode } : null;
}

export function validateThreadShareToken(
  threadId: string,
  token: string | undefined,
): ThreadShareMode | null {
  const normalized = token?.trim();
  const share = shares.get(threadId);
  if (!normalized || !share || !hashesEqual(share.tokenHash, hashToken(normalized))) return null;
  return share.mode;
}

export function createThreadShare(
  threadId: string,
  mode: ThreadShareMode,
  createdBy: string,
): Promise<CreatedThreadShare> {
  return enqueueMutation(async () => {
    const previous = shares.get(threadId);
    const token = crypto.randomBytes(32).toString("base64url");
    const share: ThreadShareRecord = {
      threadId,
      mode,
      tokenHash: hashToken(token),
      createdBy,
      createdAt: Date.now(),
      members: Object.create(null) as Record<string, number>,
    };
    shares.set(threadId, share);
    try {
      await persistShare(share);
    } catch (error) {
      if (previous) shares.set(threadId, previous);
      else shares.delete(threadId);
      throw error;
    }
    return { ...summary(share), token };
  });
}

export function redeemThreadShare(
  token: string,
  username: string,
): Promise<{ threadId: string; mode: ThreadShareMode }> {
  return enqueueMutation(async () => {
    const inspected = inspectThreadShare(token);
    if (!inspected) throw new Error("分享链接无效或已失效");
    const share = shares.get(inspected.threadId);
    if (!share) throw new Error("分享链接无效或已失效");
    if (!hasMember(share, username)) {
      share.members[username] = Date.now();
      try {
        await persistShare(share);
      } catch (error) {
        delete share.members[username];
        throw error;
      }
    }
    return { threadId: share.threadId, mode: share.mode };
  });
}

export function revokeThreadShare(threadId: string): Promise<void> {
  return enqueueMutation(async () => {
    const previous = shares.get(threadId);
    if (!previous) return;
    shares.delete(threadId);
    try {
      await removePersistedShare(threadId);
    } catch (error) {
      shares.set(threadId, previous);
      throw error;
    }
  });
}

export const deleteThreadShare = revokeThreadShare;
