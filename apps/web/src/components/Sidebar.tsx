import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  LogOut,
  MessagesSquare,
  Pin,
  Search,
  ShieldCheck,
  SquarePen,
  Trash2,
  User,
  WifiOff,
  X,
} from "lucide-react";
import type { ThreadMeta } from "@cca/protocol";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";
import {
  SIDEBAR_THREAD_LIMIT,
  sortSidebarThreads,
  visibleSidebarThreads,
} from "../lib/threadGroups";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { BrandLogo } from "./BrandLogo";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** 侧栏时间:与工作区视图一致,只保留跨度,超过一个月显示日期。 */
function relativeTime(at: number): string {
  const diff = Date.now() - at;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)}分钟`;
  if (diff < day) return `${Math.floor(diff / hour)}小时`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}天`;
  const date = new Date(at);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function Sidebar({
  onNavigate,
  onClose,
}: {
  onNavigate?: () => void;
  onClose?: () => void;
}) {
  const projects = useApp((s) => s.projects);
  const threads = useApp((s) => s.threads);
  const runningIds = useApp((s) => s.runningThreadIds);
  const createWorkspace = useApp((s) => s.createWorkspace);
  const removeWorkspace = useApp((s) => s.removeWorkspace);
  const setThreadPinned = useApp((s) => s.setThreadPinned);
  const setThreadArchived = useApp((s) => s.setThreadArchived);
  const user = useApp((s) => s.user);
  const localMode = useApp((s) => s.localMode);
  const selectLocalFolder = useApp((s) => s.selectLocalFolder);
  const logout = useApp((s) => s.logout);
  const connected = useApp((s) => s.connected);
  const appName = localMode ? "Kloud Work" : "Kloud Coding Agent";
  const location = useLocation();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [selectedFolder, setSelectedFolder] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(new Set());
  const [expandedProjects, setExpandedProjects] = useState<ReadonlySet<string>>(new Set());
  const [actionError, setActionError] = useState("");
  // 每 minute 刷新一次,让「14分钟 / 23小时」这类相对时间保持新鲜
  const [, setClock] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setClock((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const [confirmTarget, setConfirmTarget] = useState<
    { kind: "project"; id: string; name: string } | null
  >(null);

  const keyword = query.trim().toLowerCase();
  const matches = (thread: ThreadMeta) => !keyword || thread.title.toLowerCase().includes(keyword);
  const ownedProjectIds = new Set(projects.map((project) => project.id));
  const threadsByProject = (projectId: string) =>
    sortSidebarThreads(
      threads.filter((thread) => thread.projectId === projectId && !thread.archived),
    );
  const sharedThreads = threads
    .filter((thread) => !thread.archived && !ownedProjectIds.has(thread.projectId))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .filter(matches);
  const visibleProjectCount = projects.filter(
    (project) => threadsByProject(project.id).some(matches),
  ).length;

  const toggleProject = (projectId: string) => {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const toggleExpanded = (projectId: string) => {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  const togglePinned = async (thread: ThreadMeta) => {
    setActionError("");
    try {
      await setThreadPinned(thread.id, thread.pinnedAt === undefined);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "更新置顶状态失败");
    }
  };

  const archiveThread = async (thread: ThreadMeta) => {
    setActionError("");
    try {
      await setThreadArchived(thread.id, true);
      if (location.pathname === `/thread/${thread.id}`) {
        navigate("/");
        onNavigate?.();
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "归档会话失败");
    }
  };

  const createNamedWorkspace = async () => {
    const name = workspaceName.trim() || (localMode ? selectedFolder.split(/[\\/]/).filter(Boolean).at(-1) || "本地工作区" : "");
    if (creatingWorkspace || !name) return;
    setCreatingWorkspace(true);
    setWorkspaceError("");
    try {
      await createWorkspace(name, localMode ? selectedFolder || undefined : undefined);
      setWorkspaceName("");
      setSelectedFolder("");
      setAddOpen(false);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "创建工作区失败");
    } finally {
      setCreatingWorkspace(false);
    }
  };

  const renderThread = (thread: ThreadMeta, options: { manage: boolean }) => {
    const active = location.pathname === `/thread/${thread.id}`;
    const running = runningIds.includes(thread.id);
    const pinned = thread.pinnedAt !== undefined;
    const status = running
      ? <Loader2 className="size-3.5 animate-spin text-[var(--ds-link)]" strokeWidth={1.8} />
      : thread.access === "readonly"
        ? <Eye className="size-3.5 text-label-3" strokeWidth={1.8} />
        : thread.access === "collaborate"
          ? <MessagesSquare className="size-3.5 text-label-3" strokeWidth={1.8} />
          : null;
    return (
      <div key={thread.id} className="group/thread relative">
        <Link
          to={`/thread/${thread.id}`}
          onClick={onNavigate}
          title={
            thread.access === "readonly"
              ? `${thread.title}（只读分享）`
              : thread.access === "collaborate"
                ? `${thread.title}（可加入分享）`
                : thread.title
          }
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-[12px] px-2 text-[14px] leading-5 text-label-1 transition-colors hover:bg-hover",
            active && "bg-hover",
          )}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">{status}</span>
          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          {pinned && (
            <Pin
              className={cn(
                "size-3 shrink-0 text-label-3 transition-opacity",
                options.manage && !active && "group-hover/thread:opacity-0 group-focus-within/thread:opacity-0",
                active && "opacity-0",
              )}
              strokeWidth={1.8}
              aria-label="已置顶"
            />
          )}
          <span
            className={cn(
              "shrink-0 text-[11px] leading-4 tabular-nums text-label-3 transition-opacity",
              options.manage && !active && "group-hover/thread:opacity-0 group-focus-within/thread:opacity-0",
              active && "opacity-0",
            )}
          >
            {relativeTime(thread.updatedAt)}
          </span>
        </Link>
        {options.manage && (
          <div
            className={cn(
              "absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5 transition-opacity",
              active
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none opacity-0 group-hover/thread:pointer-events-auto group-hover/thread:opacity-100 group-focus-within/thread:pointer-events-auto group-focus-within/thread:opacity-100",
            )}
          >
            <button
              type="button"
              aria-label={pinned ? `取消置顶 ${thread.title}` : `置顶 ${thread.title}`}
              title={pinned ? "取消置顶" : "置顶"}
              className="flex size-6 items-center justify-center rounded-[6px] text-label-3 transition-colors hover:bg-hover hover:text-label-1"
              onClick={() => void togglePinned(thread)}
            >
              <Pin
                className={cn("size-3.5", pinned && "fill-current text-[var(--ds-link)]")}
                strokeWidth={1.8}
              />
            </button>
            <button
              type="button"
              aria-label={`归档会话 ${thread.title}`}
              title="归档"
              className="flex size-6 items-center justify-center rounded-[6px] text-label-3 transition-colors hover:bg-hover hover:text-label-1"
              onClick={() => void archiveThread(thread)}
            >
              <Archive className="size-3.5" strokeWidth={1.8} />
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <aside className="flex h-full w-full min-w-0 shrink-0 flex-col border-r-[0.5px] border-line-3 bg-panel px-3 py-1.5 md:w-[280px]">
      <div className="window-drag-region -mx-1 flex h-[60px] shrink-0 items-center gap-2 pl-1 pr-0">
        <BrandLogo className="size-6 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[17px] font-semibold leading-6 tracking-[0.02em] text-label-1">{appName}</span>
        {!connected && (
          <WifiOff className="size-3.5 shrink-0 text-[var(--ds-label-caption)]" aria-label="正在连接服务器" />
        )}
        {onClose && (
          <button
            type="button"
            aria-label="关闭侧栏"
            className="window-no-drag flex size-7 shrink-0 items-center justify-center rounded-[8px] text-label-2 transition-colors hover:bg-hover hover:text-label-1"
            onClick={onClose}
          >
            <X className="size-4" strokeWidth={1.8} />
          </button>
        )}
      </div>

      <div className="shrink-0 pb-2">
        <button
          type="button"
          className="flex h-[38px] w-full items-center justify-center gap-1.5 rounded-[12px] border-[0.5px] border-line-3 bg-elevated px-3 text-[14px] font-medium leading-[22px] text-label-1 transition-colors hover:bg-hover-solid"
          onClick={() => {
            navigate("/");
            onNavigate?.();
          }}
        >
          <SquarePen className="size-3.5 shrink-0" strokeWidth={1.8} />
          <span className="truncate">新聊天</span>
        </button>
      </div>

      <div className="flex h-9 shrink-0 items-center gap-1 pr-0.5 pl-2">
        <span className="min-w-0 flex-1 text-[12px] font-medium leading-5 text-label-3">工作区</span>
        <button
          type="button"
          aria-label="搜索会话"
          title="搜索会话"
          aria-pressed={searchOpen}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-[8px] transition-colors hover:bg-hover hover:text-label-1",
            searchOpen ? "bg-hover text-label-1" : "text-label-3",
          )}
          onClick={() => {
            setSearchOpen((open) => !open);
            if (searchOpen) setQuery("");
          }}
        >
          <Search className="size-4" strokeWidth={1.8} />
        </button>
        <button
          type="button"
          aria-label="创建工作区"
          title="创建工作区"
          className="flex size-7 shrink-0 items-center justify-center rounded-[8px] text-label-3 transition-colors hover:bg-hover hover:text-label-1"
          onClick={() => setAddOpen(true)}
        >
          <FolderPlus className="size-4" strokeWidth={1.8} />
        </button>
      </div>

      {searchOpen && (
        <div className="mb-1.5 flex h-8 shrink-0 items-center gap-1.5 rounded-[10px] border-[0.5px] border-line-3 px-2 focus-within:border-[var(--ds-label-caption)]">
          <Search className="size-3.5 shrink-0 text-label-caption" strokeWidth={1.8} />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话"
            aria-label="搜索会话"
            className="min-w-0 flex-1 bg-transparent text-[13px] leading-5 text-label-1 outline-none placeholder:text-label-3"
          />
          {query && (
            <button
              type="button"
              aria-label="清空搜索"
              className="flex size-4 shrink-0 items-center justify-center rounded-[4px] text-label-3 hover:text-label-1"
              onClick={() => setQuery("")}
            >
              <X className="size-3" strokeWidth={1.8} />
            </button>
          )}
        </div>
      )}

      {actionError && (
        <div role="alert" className="mx-1 mb-1.5 rounded-[8px] bg-red-50 px-2 py-1.5 text-[12px] leading-4 text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {actionError}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {projects
          .filter((project) => !keyword || threadsByProject(project.id).some(matches))
          .map((project) => {
            const matchedThreads = threadsByProject(project.id).filter(matches);
            const collapsed = !keyword && collapsedProjects.has(project.id);
            const expanded = keyword !== "" || expandedProjects.has(project.id);
            const { visible: projectThreads, hiddenCount } = visibleSidebarThreads(
              matchedThreads,
              expanded,
            );
            return (
              <section key={project.id} className="pb-1">
                <div className="group/workspace relative">
                  <button
                    type="button"
                    aria-expanded={!collapsed}
                    title={project.name}
                    className="flex h-[34px] w-full items-center gap-1.5 rounded-[12px] px-2 text-left text-[14px] leading-5 text-label-1 transition-colors hover:bg-hover"
                    onClick={() => toggleProject(project.id)}
                  >
                    <span className="relative flex size-4 shrink-0 items-center justify-center text-[var(--ds-label-caption)]">
                      <Folder
                        className="size-4 transition-opacity group-hover/workspace:opacity-0"
                        strokeWidth={1.6}
                      />
                      {collapsed ? (
                        <ChevronRight className="absolute size-3.5 opacity-0 transition-opacity group-hover/workspace:opacity-100" />
                      ) : (
                        <ChevronDown className="absolute size-3.5 opacity-0 transition-opacity group-hover/workspace:opacity-100" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  </button>
                  <button
                    type="button"
                    aria-label={`移除工作区 ${project.name}`}
                    title="移除工作区"
                    className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-[6px] text-label-3 opacity-0 transition-colors hover:bg-hover hover:text-label-1 group-hover/workspace:opacity-100"
                    onClick={() => setConfirmTarget({ kind: "project", id: project.id, name: project.name })}
                  >
                    <Trash2 className="size-3.5" strokeWidth={1.8} />
                  </button>
                </div>
                {!collapsed && projectThreads.map((thread) => renderThread(thread, { manage: thread.access === "owner" }))}
                {!collapsed && !keyword && matchedThreads.length > SIDEBAR_THREAD_LIMIT && (
                  <button
                    type="button"
                    aria-expanded={expanded}
                    className="flex h-7 w-full items-center gap-1 rounded-[10px] py-1 pl-[30px] pr-2 text-left text-[12px] leading-5 text-label-3 transition-colors hover:bg-hover hover:text-label-1"
                    onClick={() => toggleExpanded(project.id)}
                  >
                    {expanded
                      ? <><ChevronUp className="size-3.5" strokeWidth={1.8} />收起</>
                      : <><ChevronDown className="size-3.5" strokeWidth={1.8} />显示更多（{hiddenCount}）</>}
                  </button>
                )}
                {!collapsed && matchedThreads.length === 0 && !keyword && (
                  <div className="px-2 py-1 pl-[30px] text-[12px] leading-5 text-label-3">还没有会话</div>
                )}
              </section>
            );
          })}

        {sharedThreads.length > 0 && (
          <section className="mt-1 border-t border-line-2 pt-2">
            <div className="flex h-9 items-center gap-1.5 px-2 text-[12px] font-medium leading-5 text-label-3">
              <MessagesSquare className="size-3.5" strokeWidth={1.8} />
              共享会话
            </div>
            {sharedThreads.map((thread) => renderThread(thread, { manage: false }))}
          </section>
        )}

        {projects.length === 0 && sharedThreads.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 pt-16 text-center">
            <FolderPlus className="size-5 text-label-caption" strokeWidth={1.6} />
            <p className="text-[13px] leading-5 text-label-3">还没有工作区</p>
            <button
              type="button"
              className="text-[13px] leading-5 text-[var(--ds-link)] hover:underline"
              onClick={() => setAddOpen(true)}
            >
              创建工作区
            </button>
          </div>
        )}

        {keyword && visibleProjectCount === 0 && sharedThreads.length === 0 && (
          <div className="px-2 py-6 text-center text-[12px] leading-5 text-label-3">
            没有匹配的会话
          </div>
        )}
      </div>

      <div className="shrink-0 pb-0.5 pt-1">
        <div className="flex h-9 items-center gap-2 rounded-[12px] px-2 text-[14px] leading-5 text-label-1 transition-colors hover:bg-hover">
          <User className="size-4 shrink-0 text-label-3" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate">{localMode ? "本地工作区" : user?.username}</span>
          {user?.role === "admin" && (
            <span title="管理员" className="flex size-4 shrink-0 items-center justify-center">
              <ShieldCheck className="size-3.5 text-[var(--ds-link)]" strokeWidth={1.8} />
            </span>
          )}
          {!localMode && (
            <button
              type="button"
              aria-label="退出登录"
              title="退出登录"
              className="flex size-7 shrink-0 items-center justify-center rounded-[8px] text-label-3 transition-colors hover:bg-hover hover:text-label-1"
              onClick={() => {
                logout();
                navigate("/");
                onNavigate?.();
              }}
            >
              <LogOut className="size-4" strokeWidth={1.8} />
            </button>
          )}
        </div>
      </div>

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (creatingWorkspace) return;
          setAddOpen(open);
          if (!open) {
            setWorkspaceName("");
            setSelectedFolder("");
            setWorkspaceError("");
          }
        }}
      >
        <DialogContent>
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              void createNamedWorkspace();
            }}
          >
            <DialogHeader>
              <DialogTitle>创建工作区</DialogTitle>
              <DialogDescription>输入显示名称，服务器会创建独立且不透明的工作区目录。</DialogDescription>
            </DialogHeader>
            <Input
              value={workspaceName}
              onChange={(event) => setWorkspaceName(event.target.value)}
              placeholder="工作区名称"
              aria-label="工作区名称"
              maxLength={80}
              autoFocus
              disabled={creatingWorkspace}
            />
            {localMode && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  className="justify-start"
                  disabled={creatingWorkspace}
                  onClick={() => void selectLocalFolder().then((folder) => {
                    if (!folder) return;
                    setSelectedFolder(folder);
                    if (!workspaceName.trim()) setWorkspaceName(folder.split(/[\\/]/).filter(Boolean).at(-1) ?? "本地工作区");
                  }).catch((error) => setWorkspaceError(error instanceof Error ? error.message : "无法打开文件夹选择器"))}
                >
                  <FolderOpen className="h-4 w-4" />
                  {selectedFolder ? "重新选择本地文件夹" : "选择本地文件夹"}
                </Button>
                {selectedFolder && <div className="truncate rounded-[8px] bg-hover px-2.5 py-2 text-xs text-label-3" title={selectedFolder}>{selectedFolder}</div>}
              </>
            )}
            {workspaceError && <p className="text-xs text-red-600 dark:text-red-400">{workspaceError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={creatingWorkspace} onClick={() => setAddOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={creatingWorkspace || (!workspaceName.trim() && !selectedFolder)}>
                {creatingWorkspace && <Loader2 className="animate-spin" />}
                创建
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
        title="移除工作区？"
        description={confirmTarget ? `将移除“${confirmTarget.name}”，其中的归档会话也会被删除；磁盘文件不会删除。` : ""}
        confirmLabel="移除"
        destructive
        onConfirm={() => {
          if (confirmTarget) void removeWorkspace(confirmTarget.id);
          setConfirmTarget(null);
        }}
      />
    </aside>
  );
}
