import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  FolderPlus,
  Loader2,
  LogOut,
  Search,
  ShieldCheck,
  SquarePen,
  User,
  WifiOff,
  X,
} from "lucide-react";
import type { ThreadMeta } from "@cca/protocol";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";
import { listSidebarThreads } from "../lib/threadGroups";
import { Button } from "@/components/ui/button";
import { BrandLogo } from "./BrandLogo";
import { SidebarThreadCard } from "./SidebarThreadCard";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

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
  const setThreadPinned = useApp((s) => s.setThreadPinned);
  const setThreadArchived = useApp((s) => s.setThreadArchived);
  const user = useApp((s) => s.user);
  const logout = useApp((s) => s.logout);
  const connected = useApp((s) => s.connected);
  const appName = "Kloud Coding Agent";
  const location = useLocation();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [creatingWorkspace, setCreatingWorkspace] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [actionError, setActionError] = useState("");
  const [threadListScrolling, setThreadListScrolling] = useState(false);
  const threadListScrollIdle = useRef(0);
  // 每 minute 刷新一次，让「5m / 2h / 7d」这类相对时间保持新鲜
  const [, setClock] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setClock((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => () => window.clearTimeout(threadListScrollIdle.current), []);
  const onThreadListScroll = () => {
    setThreadListScrolling(true);
    window.clearTimeout(threadListScrollIdle.current);
    threadListScrollIdle.current = window.setTimeout(() => setThreadListScrolling(false), 400);
  };

  const keyword = query.trim();
  const listedThreads = listSidebarThreads(threads, projects, keyword);
  const projectsById = new Map(projects.map((project) => [project.id, project]));

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
    const name = workspaceName.trim();
    if (creatingWorkspace || !name) return;
    setCreatingWorkspace(true);
    setWorkspaceError("");
    try {
      await createWorkspace(name);
      setWorkspaceName("");
      setAddOpen(false);
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "创建工作区失败");
    } finally {
      setCreatingWorkspace(false);
    }
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

      <div
        className="sidebar-thread-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-3"
        data-scrolling={threadListScrolling ? "" : undefined}
        onScroll={onThreadListScroll}
      >
        {listedThreads.map((thread) => (
          <SidebarThreadCard
            key={thread.id}
            thread={thread}
            project={projectsById.get(thread.projectId)}
            active={location.pathname === `/thread/${thread.id}`}
            running={runningIds.includes(thread.id)}
            manage={thread.access === "owner"}
            onNavigate={onNavigate}
            onTogglePinned={(item) => void togglePinned(item)}
            onArchive={(item) => void archiveThread(item)}
          />
        ))}

        {projects.length === 0 && listedThreads.length === 0 && !keyword && (
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

        {projects.length > 0 && listedThreads.length === 0 && !keyword && (
          <div className="px-2 py-6 text-center text-[12px] leading-5 text-label-3">
            还没有会话
          </div>
        )}

        {keyword && listedThreads.length === 0 && (
          <div className="px-2 py-6 text-center text-[12px] leading-5 text-label-3">
            没有匹配的会话
          </div>
        )}
      </div>

      <div className="shrink-0 pb-0.5 pt-1">
        <div className="flex h-9 items-center gap-2 rounded-[12px] px-2 text-[14px] leading-5 text-label-1 transition-colors hover:bg-hover">
          <User className="size-4 shrink-0 text-label-3" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate">{user?.username}</span>
          {user?.role === "admin" && (
            <span title="管理员" className="flex size-4 shrink-0 items-center justify-center">
              <ShieldCheck className="size-3.5 text-[var(--ds-link)]" strokeWidth={1.8} />
            </span>
          )}
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
        </div>
      </div>

      <Dialog
        open={addOpen}
        onOpenChange={(open) => {
          if (creatingWorkspace) return;
          setAddOpen(open);
          if (!open) {
            setWorkspaceName("");
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
            {workspaceError && <p className="text-xs text-red-600 dark:text-red-400">{workspaceError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={creatingWorkspace} onClick={() => setAddOpen(false)}>
                取消
              </Button>
              <Button type="submit" disabled={creatingWorkspace || !workspaceName.trim()}>
                {creatingWorkspace && <Loader2 className="animate-spin" />}
                创建
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </aside>
  );
}
