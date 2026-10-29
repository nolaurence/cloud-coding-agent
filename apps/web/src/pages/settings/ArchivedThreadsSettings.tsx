import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Archive, FolderGit2, Loader2, RotateCcw } from "lucide-react";
import type { ThreadMeta } from "@cca/protocol";
import { useApp } from "../../lib/store";
import {
  archivedDaysRemaining,
  groupArchivedThreads,
} from "../../lib/threadGroups";
import { Button } from "@/components/ui/button";

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(value: number) {
  return dateFormatter.format(new Date(value));
}

function retentionLabel(thread: ThreadMeta) {
  const days = archivedDaysRemaining(thread);
  if (days === null) return "等待自动清理";
  if (days === 0) return "今天自动删除";
  return `还剩 ${days} 天自动删除`;
}

export function ArchivedThreadsSettings() {
  const projects = useApp((state) => state.projects);
  const threads = useApp((state) => state.threads);
  const setThreadArchived = useApp((state) => state.setThreadArchived);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [error, setError] = useState("");

  const groups = useMemo(
    () => groupArchivedThreads(threads, projects),
    [projects, threads],
  );

  const restore = async (thread: ThreadMeta) => {
    if (restoring) return;
    setRestoring(thread.id);
    setError("");
    try {
      await setThreadArchived(thread.id, false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "恢复会话失败");
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h2 className="text-base font-semibold">归档对话</h2>
        <p className="mt-1 text-sm text-zinc-500">
          归档的会话只读保留，满 30 天后自动删除。可按工作区查看并随时恢复。
        </p>
      </header>

      {error && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      )}

      {groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-zinc-300 px-4 py-12 text-center dark:border-zinc-700">
          <Archive className="h-6 w-6 text-zinc-400" strokeWidth={1.6} />
          <p className="text-sm font-medium">还没有归档对话</p>
          <p className="text-xs text-zinc-500">在左侧会话上悬停，点击归档按钮即可移到这里。</p>
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.project.id} className="flex flex-col gap-2">
            <div className="flex items-center gap-2 px-1">
              <FolderGit2 className="h-4 w-4 text-zinc-400" strokeWidth={1.8} />
              <h3 className="min-w-0 flex-1 truncate text-sm font-medium">{group.project.name}</h3>
              <span className="text-xs text-zinc-500">{group.threads.length} 个会话</span>
            </div>
            <div className="divide-y divide-zinc-200 overflow-hidden rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
              {group.threads.map((thread) => (
                <div key={thread.id} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/thread/${thread.id}`}
                      className="block truncate text-sm text-zinc-900 hover:underline dark:text-zinc-100"
                      title={thread.title}
                    >
                      {thread.title}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-zinc-500">
                      <span>归档于 {formatDate(thread.archivedAt ?? thread.updatedAt)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{retentionLabel(thread)}</span>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={restoring !== null}
                    onClick={() => void restore(thread)}
                  >
                    {restoring === thread.id
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <RotateCcw className="h-4 w-4" />}
                    恢复
                  </Button>
                </div>
              ))}
            </div>
          </section>
        ))
      )}
    </div>
  );
}
