import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  GitFileChange,
  GitFileDiffResult,
  GitFileStatus,
  GitLogResult,
  GitWorkspaceStatus,
  GitCommitResult,
} from "@cca/protocol";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
  History,
  ListChecks,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { request } from "../../lib/client";
import { layoutGitGraph, type GitGraphRow } from "../../lib/gitGraph";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { DiffViewer } from "./DiffViewer";

type GitView = "changes" | "history";
type FileSelection = { path: string; staged: boolean };

const GRAPH_COLORS = ["#2563eb", "#16a34a", "#d97706", "#dc2626", "#7c3aed", "#0891b2"];

const STATUS_LABELS: Record<GitFileStatus, string> = {
  M: "修改",
  A: "新增",
  D: "删除",
  R: "重命名",
  C: "复制",
  U: "冲突",
  "?": "未跟踪",
};

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

function shortPath(file: GitFileChange) {
  const parts = file.path.split("/");
  return { name: parts.pop() || file.path, directory: parts.join("/") };
}

function relativeDate(timestamp: number) {
  const elapsed = timestamp - Date.now();
  const absolute = Math.abs(elapsed);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (absolute < 60_000) return formatter.format(Math.round(elapsed / 1_000), "second");
  if (absolute < 3_600_000) return formatter.format(Math.round(elapsed / 60_000), "minute");
  if (absolute < 86_400_000) return formatter.format(Math.round(elapsed / 3_600_000), "hour");
  if (absolute < 2_592_000_000) return formatter.format(Math.round(elapsed / 86_400_000), "day");
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(timestamp);
}

function statusColor(status: GitFileStatus) {
  if (status === "A" || status === "?") return "text-emerald-600 dark:text-emerald-400";
  if (status === "D" || status === "U") return "text-red-600 dark:text-red-400";
  if (status === "R" || status === "C") return "text-blue-600 dark:text-blue-400";
  return "text-amber-600 dark:text-amber-400";
}

export function GitPanel({
  projectId,
  threadId,
  editable,
}: {
  projectId: string;
  threadId: string;
  editable: boolean;
}) {
  const [view, setView] = useState<GitView>("changes");
  const [status, setStatus] = useState<GitWorkspaceStatus | null>(null);
  const [log, setLog] = useState<GitLogResult | null>(null);
  const [logLimit, setLogLimit] = useState(100);
  const [queryDraft, setQueryDraft] = useState("");
  const [query, setQuery] = useState("");
  const [selection, setSelection] = useState<FileSelection | null>(null);
  const [fileDiff, setFileDiff] = useState<GitFileDiffResult | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const loadStatus = useCallback(async () => {
    const next = await request<GitWorkspaceStatus>({ type: "project.git.status", projectId });
    setStatus(next);
    return next;
  }, [projectId]);

  const loadLog = useCallback(async () => {
    const next = await request<GitLogResult>({
      type: "project.git.log",
      projectId,
      limit: logLimit,
      ...(query ? { query } : {}),
    });
    setLog(next);
    return next;
  }, [logLimit, projectId, query]);

  const loadFileDiff = useCallback(async (nextSelection: FileSelection) => {
    setSelection(nextSelection);
    setDiffLoading(true);
    setFileDiff(null);
    try {
      setFileDiff(await request<GitFileDiffResult>({
        type: "project.git.fileDiff",
        projectId,
        path: nextSelection.path,
        staged: nextSelection.staged,
      }));
    } catch (reason) {
      setError(errorMessage(reason, "读取文件差异失败"));
    } finally {
      setDiffLoading(false);
    }
  }, [projectId]);

  const refresh = useCallback(async (includeLog = true) => {
    setLoading(true);
    setError("");
    try {
      await Promise.all([loadStatus(), ...(includeLog ? [loadLog()] : [])]);
    } catch (reason) {
      setError(errorMessage(reason, "读取 Git 工作区失败"));
    } finally {
      setLoading(false);
    }
  }, [loadLog, loadStatus]);

  useEffect(() => {
    setStatus(null);
    setLog(null);
    setSelection(null);
    setFileDiff(null);
    setError("");
    setNotice("");
    void refresh();
  }, [projectId, refresh, threadId]);

  const mutate = async (
    name: string,
    action: () => Promise<unknown>,
    success: string,
    nextSelection?: FileSelection | null,
  ) => {
    setOperation(name);
    setError("");
    setNotice("");
    try {
      await action();
      const nextStatus = await loadStatus();
      setNotice(success);
      if (nextSelection) {
        const remaining = nextStatus.files.some((file) => file.path === nextSelection.path);
        if (remaining) await loadFileDiff(nextSelection);
        else {
          setSelection(null);
          setFileDiff(null);
        }
      } else if (nextSelection === null) {
        setSelection(null);
        setFileDiff(null);
      }
      if (name === "commit" || name === "pull" || name === "push") await loadLog();
    } catch (reason) {
      setError(errorMessage(reason, "Git 操作失败"));
    } finally {
      setOperation(null);
    }
  };

  const toggleFile = async (file: GitFileChange, include: boolean) => {
    if (!status) return;
    await mutate(
      include ? "stage" : "unstage",
      () => request({
        type: include ? "project.git.stage" : "project.git.unstage",
        threadId,
        projectId,
        paths: [file.path],
        expectedHead: status.head,
        expectedIndexTree: status.indexTree,
      }),
      include ? `已暂存 ${file.path}` : `已取消暂存 ${file.path}`,
      { path: file.path, staged: include },
    );
  };

  const allFullyStaged = Boolean(status?.files.length)
    && status!.files.every((file) => file.staged && !file.unstaged);
  const stagedCount = status?.files.filter((file) => file.staged).length ?? 0;
  const graphRows = useMemo(() => layoutGitGraph(log?.commits ?? []), [log]);

  const toggleAll = async () => {
    if (!status?.files.length) return;
    const include = !allFullyStaged;
    const paths = status.files
      .filter((file) => include ? Boolean(file.unstaged) : Boolean(file.staged))
      .map((file) => file.path);
    if (!paths.length) return;
    await mutate(
      include ? "stage-all" : "unstage-all",
      () => request({
        type: include ? "project.git.stage" : "project.git.unstage",
        threadId,
        projectId,
        paths,
        expectedHead: status.head,
        expectedIndexTree: status.indexTree,
      }),
      include ? `已暂存 ${paths.length} 个文件` : `已取消暂存 ${paths.length} 个文件`,
      null,
    );
  };

  const commit = async () => {
    if (!status || !commitMessage.trim() || stagedCount === 0) return;
    const message = commitMessage.trim();
    await mutate(
      "commit",
      async () => {
        const result = await request<GitCommitResult>({
          type: "project.git.commit",
          threadId,
          projectId,
          message,
          stageAll: false,
          expectedHead: status.head,
          expectedIndexTree: status.indexTree,
        });
        setCommitMessage("");
        return result;
      },
      "提交已创建",
      null,
    );
  };

  const sync = async (direction: "pull" | "push") => {
    await mutate(
      direction,
      () => request({
        type: direction === "pull" ? "project.git.pull" : "project.git.push",
        threadId,
        projectId,
      }, 130_000),
      direction === "pull" ? "代码已拉取到最新版本" : "代码已推送",
      null,
    );
  };

  return (
    <div className="git-workspace flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate font-medium">{status?.branch ?? (status?.detached ? "detached HEAD" : "Git")}</span>
          {status?.upstream && <span className="hidden truncate text-muted-foreground xl:inline">{status.upstream}</span>}
          {Boolean(status?.ahead) && <span className="text-emerald-600">↑{status?.ahead}</span>}
          {Boolean(status?.behind) && <span className="text-amber-600">↓{status?.behind}</span>}
        </div>
        {editable && (
          <>
            <Button type="button" variant="ghost" size="icon-xs" title="拉取" aria-label="拉取" disabled={operation !== null} onClick={() => void sync("pull")}>
              {operation === "pull" ? <Loader2 className="animate-spin" /> : <ArrowDownToLine />}
            </Button>
            <Button type="button" variant="ghost" size="icon-xs" title="推送" aria-label="推送" disabled={operation !== null} onClick={() => void sync("push")}>
              {operation === "push" ? <Loader2 className="animate-spin" /> : <ArrowUpFromLine />}
            </Button>
          </>
        )}
        <Button type="button" variant="ghost" size="icon-xs" title="刷新 Git" aria-label="刷新 Git" disabled={loading || operation !== null} onClick={() => void refresh()}>
          <RefreshCw className={loading ? "animate-spin" : ""} />
        </Button>
      </div>

      <div className="flex h-9 shrink-0 items-center border-b px-2">
        <div className="flex h-7 rounded-md bg-muted p-0.5">
          <Button type="button" variant={view === "changes" ? "secondary" : "ghost"} size="xs" className="h-6" onClick={() => setView("changes")}>
            <ListChecks />更改 {status?.files.length ?? 0}
          </Button>
          <Button type="button" variant={view === "history" ? "secondary" : "ghost"} size="xs" className="h-6" onClick={() => setView("history")}>
            <History />历史
          </Button>
        </div>
      </div>

      {error ? (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-950 dark:bg-red-950/30 dark:text-red-300">{error}</div>
      ) : notice ? (
        <div className="shrink-0 border-b border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-300">{notice}</div>
      ) : null}

      {view === "changes" ? (
        <div className="git-workspace-layout grid min-h-0 flex-1 overflow-hidden">
          <div className="git-workspace-sidebar flex min-h-0 flex-col">
            <div className="flex h-8 shrink-0 items-center gap-2 border-b px-2 text-[11px] font-medium text-muted-foreground">
              {editable && (
                <input
                  type="checkbox"
                  className="size-3.5 accent-primary"
                  checked={allFullyStaged}
                  ref={(element) => {
                    if (element) element.indeterminate = stagedCount > 0 && !allFullyStaged;
                  }}
                  aria-label={allFullyStaged ? "取消暂存全部" : "暂存全部"}
                  disabled={!status?.files.length || operation !== null}
                  onChange={() => void toggleAll()}
                />
              )}
              <span className="flex-1">待提交 {stagedCount}/{status?.files.length ?? 0}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto py-1">
              {loading && !status ? (
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />读取状态…</div>
              ) : status?.files.length ? status.files.map((file) => (
                <GitFileRow
                  key={file.path}
                  file={file}
                  editable={editable}
                  disabled={operation !== null}
                  selectedStaged={selection?.path === file.path ? selection.staged : undefined}
                  onToggle={(include) => void toggleFile(file, include)}
                  onOpen={(staged) => void loadFileDiff({ path: file.path, staged })}
                />
              )) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs text-muted-foreground">
                  <Check className="size-5 text-emerald-500" />工作区没有更改
                </div>
              )}
            </div>
            {editable && (
              <form className="shrink-0 space-y-2 border-t p-2" onSubmit={(event) => { event.preventDefault(); void commit(); }}>
                <Textarea
                  value={commitMessage}
                  onChange={(event) => setCommitMessage(event.target.value)}
                  placeholder="提交说明"
                  aria-label="提交说明"
                  maxLength={2000}
                  disabled={operation !== null}
                  className="min-h-14 resize-none text-xs"
                />
                <Button type="submit" size="sm" className="w-full" disabled={operation !== null || stagedCount === 0 || !commitMessage.trim()}>
                  {operation === "commit" ? <Loader2 className="animate-spin" /> : <GitCommitHorizontal />}
                  提交已暂存更改 ({stagedCount})
                </Button>
              </form>
            )}
          </div>
          <div className="min-h-0 overflow-hidden">
            {selection ? (
              <DiffViewer
                patch={fileDiff?.patch}
                loading={diffLoading}
                truncated={fileDiff?.truncated ?? false}
                untrackedFiles={[]}
                untrackedTotal={0}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">选择文件查看差异</div>
            )}
          </div>
        </div>
      ) : (
        <HistoryView
          rows={graphRows}
          loading={loading && !log}
          queryDraft={queryDraft}
          onQueryDraft={setQueryDraft}
          onSearch={() => {
            setQuery(queryDraft.trim());
            if (query === queryDraft.trim()) void loadLog();
          }}
          hasMore={log?.hasMore ?? false}
          onMore={() => setLogLimit((value) => Math.min(value + 100, 200))}
        />
      )}
    </div>
  );
}

function GitFileRow({
  file,
  editable,
  disabled,
  selectedStaged,
  onToggle,
  onOpen,
}: {
  file: GitFileChange;
  editable: boolean;
  disabled: boolean;
  selectedStaged?: boolean;
  onToggle: (include: boolean) => void;
  onOpen: (staged: boolean) => void;
}) {
  const { name, directory } = shortPath(file);
  const fullyStaged = Boolean(file.staged && !file.unstaged);
  const partial = Boolean(file.staged && file.unstaged);
  const previewStaged = Boolean(file.staged && !file.unstaged);

  return (
    <div className={cn("flex w-full items-center px-2 hover:bg-muted/70", selectedStaged !== undefined && "bg-muted")}>
      {editable && (
        <input
          type="checkbox"
          className="size-3.5 shrink-0 accent-primary"
          checked={fullyStaged}
          ref={(element) => { if (element) element.indeterminate = partial; }}
          aria-label={file.staged ? `取消暂存 ${file.path}` : `暂存 ${file.path}`}
          disabled={disabled}
          onChange={(event) => onToggle(event.currentTarget.checked)}
        />
      )}
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 text-left" onClick={() => onOpen(previewStaged)}>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1 text-xs">
            <span className="truncate font-medium">{name}</span>
            {directory && <span className="truncate text-[10px] text-muted-foreground">{directory}</span>}
          </div>
          {file.oldPath && <div className="truncate text-[10px] text-muted-foreground">原路径 {file.oldPath}</div>}
        </div>
      </button>
      <div className="flex shrink-0 items-center gap-0.5 text-[10px]">
        {file.staged && (
          <button
            type="button"
            className={cn("rounded-sm px-1 py-0.5", statusColor(file.staged), selectedStaged === true && "bg-background shadow-sm")}
            title={`查看已暂存差异 · ${STATUS_LABELS[file.staged]}`}
            aria-label={`查看 ${file.path} 的已暂存差异`}
            onClick={() => onOpen(true)}
          >
            S:{file.staged}
          </button>
        )}
        {file.unstaged && (
          <button
            type="button"
            className={cn("rounded-sm px-1 py-0.5", statusColor(file.unstaged), selectedStaged === false && "bg-background shadow-sm")}
            title={`查看工作区差异 · ${STATUS_LABELS[file.unstaged]}`}
            aria-label={`查看 ${file.path} 的工作区差异`}
            onClick={() => onOpen(false)}
          >
            W:{file.unstaged}
          </button>
        )}
      </div>
    </div>
  );
}

function HistoryView({
  rows,
  loading,
  queryDraft,
  onQueryDraft,
  onSearch,
  hasMore,
  onMore,
}: {
  rows: GitGraphRow[];
  loading: boolean;
  queryDraft: string;
  onQueryDraft: (value: string) => void;
  onSearch: () => void;
  hasMore: boolean;
  onMore: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form className="flex shrink-0 gap-1 border-b p-2" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
        <Input value={queryDraft} onChange={(event) => onQueryDraft(event.target.value)} placeholder="搜索提交说明" aria-label="搜索提交说明" className="h-7 min-w-0 flex-1 text-xs" />
        <Button type="submit" variant="ghost" size="icon-sm" aria-label="搜索历史" title="搜索历史"><Search /></Button>
      </form>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-foreground"><Loader2 className="mr-2 size-4 animate-spin" />读取提交历史…</div>
        ) : rows.length ? (
          <div className="divide-y">
            {rows.map((row) => <CommitRow key={row.commit.hash} row={row} />)}
            {hasMore && (
              <div className="p-2 text-center"><Button type="button" variant="ghost" size="sm" onClick={onMore}>加载更多</Button></div>
            )}
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">没有匹配的提交</div>
        )}
      </div>
    </div>
  );
}

function CommitRow({ row }: { row: GitGraphRow }) {
  const [expanded, setExpanded] = useState(false);
  const maxLane = Math.max(row.lane, ...row.activeLanes, ...row.parentLanes, 0);
  const graphWidth = (maxLane + 1) * 12 + 8;
  const laneX = (lane: number) => lane * 12 + 8;

  return (
    <button type="button" className="flex w-full items-stretch px-2 py-2 text-left hover:bg-muted/60" onClick={() => setExpanded((value) => !value)}>
      <svg width={graphWidth} height={expanded ? 64 : 44} className="shrink-0 overflow-visible" aria-hidden="true">
        {row.activeLanes.map((lane) => (
          <line key={`active-${lane}`} x1={laneX(lane)} y1="0" x2={laneX(lane)} y2="44" stroke={GRAPH_COLORS[lane % GRAPH_COLORS.length]} strokeWidth="1.5" opacity="0.65" />
        ))}
        {row.parentLanes.map((parentLane, index) => (
          <line key={`parent-${index}-${parentLane}`} x1={laneX(row.lane)} y1="13" x2={laneX(parentLane)} y2="44" stroke={GRAPH_COLORS[parentLane % GRAPH_COLORS.length]} strokeWidth="1.5" />
        ))}
        <circle cx={laneX(row.lane)} cy="13" r="4" fill={GRAPH_COLORS[row.lane % GRAPH_COLORS.length]} stroke="var(--background)" strokeWidth="2" />
      </svg>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {expanded ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
          <span className="truncate text-xs font-medium">{row.commit.subject || "无提交说明"}</span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
          <span className="font-mono">{row.commit.shortHash}</span>
          <span className="truncate">{row.commit.author}</span>
          <span className="shrink-0">{relativeDate(row.commit.date)}</span>
        </div>
        {row.commit.refs.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {row.commit.refs.slice(0, 6).map((ref) => <span key={ref} className="max-w-48 truncate rounded-sm bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">{ref}</span>)}
          </div>
        )}
        {expanded && (
          <div className="mt-2 space-y-1 border-t pt-2 text-[10px] text-muted-foreground">
            <div className="break-all font-mono">{row.commit.hash}</div>
            <div>{row.commit.author} &lt;{row.commit.email}&gt;</div>
            {row.commit.parents.length > 1 && <div>合并 {row.commit.parents.length} 个父提交</div>}
          </div>
        )}
      </div>
    </button>
  );
}
