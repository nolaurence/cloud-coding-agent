import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SessionId, type SessionEvent } from "@deepseek-ai/dsh-session";
import { SessionPersistenceNotFoundError, type SessionHandle } from "@deepseek-ai/dsh-session-persistence";
import * as JsonlPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import type { DshTrajectoryPage, DshTrajectoryQuery } from "@cca/protocol";
import { DATA_DIR } from "../env.js";

function page(events: readonly SessionEvent[], query: DshTrajectoryQuery, limit: number, revision: string): DshTrajectoryPage {
  const total = events.length;
  const start = query.afterSeq !== undefined
    ? Math.min(total, query.afterSeq + 1)
    : Math.max(0, Math.min(total, query.beforeSeq ?? total) - limit);
  const end = query.afterSeq !== undefined
    ? Math.min(total, start + limit)
    : Math.min(total, query.beforeSeq ?? total);
  return {
    events: events.slice(start, end),
    hasMoreBefore: start > 0,
    hasMoreAfter: end < total,
    revision,
  };
}

/** Read native durable events without attaching or launching an agent runtime. */
export async function readDshTrajectory(threadId: string, query: DshTrajectoryQuery = {}): Promise<DshTrajectoryPage> {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(threadId)) throw new Error("会话标识无效");
  if (query.beforeSeq !== undefined && (!Number.isSafeInteger(query.beforeSeq) || query.beforeSeq < 0)) {
    throw new Error("beforeSeq 必须为非负整数");
  }
  if (query.afterSeq !== undefined && (!Number.isSafeInteger(query.afterSeq) || query.afterSeq < -1)) {
    throw new Error("afterSeq 必须为不小于 -1 的整数");
  }
  if (query.beforeSeq !== undefined && query.afterSeq !== undefined) throw new Error("不能同时指定前后游标");
  const limit = query.limit ?? 200;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("轨迹页大小必须为 1 到 500 的整数");
  if (query.knownRevision !== undefined && typeof query.knownRevision !== "string") throw new Error("轨迹版本无效");
  const ctx = new Context();
  try {
    await ctx.plugin(JsonlPersistence, { root: path.join(DATA_DIR, "dsh-home", threadId, "sessions") });
    const id = SessionId(threadId);
    const snapshot = await ctx.sessionPersistence.stat(id);
    const revision = snapshot?.revision ?? "empty";
    if (query.afterSeq !== undefined && query.knownRevision === revision) {
      return { events: [], hasMoreBefore: false, hasMoreAfter: false, revision, unchanged: true };
    }
    if (!snapshot) return page([], query, limit, revision);
    let handle: SessionHandle;
    try {
      handle = await ctx.sessionPersistence.open(id, "read");
    } catch (error) {
      if (error instanceof SessionPersistenceNotFoundError) return page([], query, limit, "empty");
      throw error;
    }
    try {
      return page((await handle.read()).events, query, limit, revision);
    } finally {
      await handle.close();
    }
  } finally {
    await ctx.fiber.dispose();
  }
}
