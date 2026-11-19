import type { DshTrajectoryEvent, DshTrajectoryPage, DshTrajectoryQuery } from "@cca/protocol";

/** 两种原生引擎(DSH / Codex)轨迹读取共用的会话标识约束。 */
export function assertTrajectoryThreadId(threadId: string): void {
  if (!/^[A-Za-z0-9-]{1,100}$/.test(threadId)) throw new Error("会话标识无效");
}

/** 校验并归一化后的轨迹查询;两种引擎的分页口径必须保持一致。 */
export interface ResolvedTrajectoryQuery {
  beforeSeq?: number;
  afterSeq?: number;
  limit: number;
  knownRevision?: string;
}

export function resolveTrajectoryQuery(query: DshTrajectoryQuery): ResolvedTrajectoryQuery {
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
  return {
    ...(query.beforeSeq === undefined ? {} : { beforeSeq: query.beforeSeq }),
    ...(query.afterSeq === undefined ? {} : { afterSeq: query.afterSeq }),
    limit,
    ...(query.knownRevision === undefined ? {} : { knownRevision: query.knownRevision }),
  };
}

/** 轮询命中未变更 revision 时的空页,避免前端重复投影同一段日志。 */
export function unchangedTrajectoryPage(revision: string): DshTrajectoryPage {
  return { events: [], hasMoreBefore: false, hasMoreAfter: false, revision, unchanged: true };
}

/** 按前后游标切页;事件 seq 必须稠密且从 0 开始,与前端合并逻辑一致。 */
export function trajectoryPage(
  events: readonly DshTrajectoryEvent[],
  query: ResolvedTrajectoryQuery,
  revision: string,
): DshTrajectoryPage {
  const total = events.length;
  const start = query.afterSeq !== undefined
    ? Math.min(total, query.afterSeq + 1)
    : Math.max(0, Math.min(total, query.beforeSeq ?? total) - query.limit);
  const end = query.afterSeq !== undefined
    ? Math.min(total, start + query.limit)
    : Math.min(total, query.beforeSeq ?? total);
  return { events: events.slice(start, end), hasMoreBefore: start > 0, hasMoreAfter: end < total, revision };
}
