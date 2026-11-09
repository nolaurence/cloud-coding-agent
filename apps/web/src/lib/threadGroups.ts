import {
  archivedThreadExpiresAt,
  type ThreadMeta,
  type Workspace,
} from "@cca/protocol";

export const SIDEBAR_THREAD_LIMIT = 6;

function archiveTime(thread: ThreadMeta): number {
  return thread.archivedAt ?? thread.updatedAt;
}

/** 置顶会话优先；同为置顶时最近置顶的在前，其余按更新时间倒序。 */
export function sortSidebarThreads(threads: readonly ThreadMeta[]): ThreadMeta[] {
  return [...threads].sort((left, right) => {
    const leftPinned = left.pinnedAt ?? null;
    const rightPinned = right.pinnedAt ?? null;
    if (leftPinned !== null || rightPinned !== null) {
      if (leftPinned === null) return 1;
      if (rightPinned === null) return -1;
      if (leftPinned !== rightPinned) return rightPinned - leftPinned;
    }
    return right.updatedAt - left.updatedAt;
  });
}

export function visibleSidebarThreads(
  threads: readonly ThreadMeta[],
  expanded: boolean,
): { visible: ThreadMeta[]; hiddenCount: number } {
  const visible = expanded ? [...threads] : threads.slice(0, SIDEBAR_THREAD_LIMIT);
  return { visible, hiddenCount: Math.max(0, threads.length - visible.length) };
}

/** 侧栏卡片时间：与 t3code compact label 一致（刚刚 / 5m / 2h / 7d）。 */
export function compactSidebarTime(at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)}m`;
  if (diff < day) return `${Math.floor(diff / hour)}h`;
  return `${Math.floor(diff / day)}d`;
}

/**
 * ThreadMeta 目前没有会话绑定的 branch / PR。
 * 若后端之后挂上同名字段，侧栏卡片会自动展示。
 */
export function threadGitPresentation(thread: ThreadMeta): {
  branch?: string;
  pullRequestNumber?: number;
} {
  const record = thread as ThreadMeta & {
    branch?: unknown;
    pullRequestNumber?: unknown;
    prNumber?: unknown;
  };
  const branch = typeof record.branch === "string" ? record.branch.trim() : "";
  const raw = record.pullRequestNumber ?? record.prNumber;
  const pullRequestNumber =
    typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
  return {
    ...(branch ? { branch } : {}),
    ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
  };
}

/** 活跃会话按时间倒序平铺；搜索同时匹配标题和工作区名。 */
export function listSidebarThreads(
  threads: readonly ThreadMeta[],
  projects: readonly Workspace[],
  query = "",
): ThreadMeta[] {
  const keyword = query.trim().toLowerCase();
  const names = new Map(projects.map((project) => [project.id, project.name]));
  return sortSidebarThreads(
    threads.filter((thread) => {
      if (thread.archived) return false;
      if (!keyword) return true;
      if (thread.title.toLowerCase().includes(keyword)) return true;
      return (names.get(thread.projectId) ?? "").toLowerCase().includes(keyword);
    }),
  );
}

export interface ArchivedThreadGroup {
  project: Workspace;
  threads: ThreadMeta[];
  archivedAt: number;
}

/** 归档页按工作区分组；组和组内会话都按归档时间倒序。 */
export function groupArchivedThreads(
  threads: readonly ThreadMeta[],
  projects: readonly Workspace[],
): ArchivedThreadGroup[] {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const grouped = new Map<string, ThreadMeta[]>();
  for (const thread of threads) {
    if (!thread.archived || !projectsById.has(thread.projectId)) continue;
    const list = grouped.get(thread.projectId) ?? [];
    list.push(thread);
    grouped.set(thread.projectId, list);
  }

  return [...grouped.entries()]
    .map(([projectId, list]) => {
      const sorted = [...list].sort((left, right) => archiveTime(right) - archiveTime(left));
      return {
        project: projectsById.get(projectId)!,
        threads: sorted,
        archivedAt: archiveTime(sorted[0]!),
      };
    })
    .sort((left, right) =>
      right.archivedAt - left.archivedAt ||
      left.project.name.localeCompare(right.project.name),
    );
}

export function archivedDaysRemaining(thread: ThreadMeta, now = Date.now()): number | null {
  const expiresAt = archivedThreadExpiresAt(thread);
  if (expiresAt === null) return null;
  return Math.max(0, Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000)));
}
