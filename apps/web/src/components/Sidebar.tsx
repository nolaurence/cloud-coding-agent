import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Folder,
  FolderOpen,
  FolderPlus,
  Eye,
  Loader2,
  LogOut,
  MessageSquare,
  MessagesSquare,
  PanelLeftClose,
  ShieldCheck,
  SquarePen,
  Trash2,
  User,
  WifiOff,
  X,
} from "lucide-react";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";
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

export function Sidebar({
  onNavigate,
  onClose,
  onCollapse,
}: {
  onNavigate?: () => void;
  onClose?: () => void;
  onCollapse?: () => void;
}) {
  const projects = useApp((s) => s.projects);
  const threads = useApp((s) => s.threads);
  const runningIds = useApp((s) => s.runningThreadIds);
  const createWorkspace = useApp((s) => s.createWorkspace);
  const removeWorkspace = useApp((s) => s.removeWorkspace);
  const deleteThread = useApp((s) => s.deleteThread);
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
  const [confirmTarget, setConfirmTarget] = useState<
    | { kind: "project"; id: string; name: string }
    | { kind: "thread"; id: string; name: string; active: boolean }
    | null
  >(null);

  const ownedProjectIds = new Set(projects.map((project) => project.id));
  const threadsByProject = (projectId: string) =>
    threads
      .filter((thread) => thread.projectId === projectId && !thread.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  const sharedThreads = threads
    .filter((thread) => !thread.archived && !ownedProjectIds.has(thread.projectId))
    .sort((a, b) => b.updatedAt - a.updatedAt);

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

  return (
    <aside className="flex h-full w-full min-w-0 shrink-0 flex-col border-r-[0.5px] border-line-3 bg-panel px-3 py-1.5 md:w-[280px]">
      <div className="window-drag-region -mx-1 flex h-[60px] shrink-0 items-center gap-2 pl-1 pr-0">
        <BrandLogo className="size-6 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-[17px] font-semibold leading-6 tracking-[0.02em] text-label-1">{appName}</span>
        {!connected && (
          <WifiOff className="size-3.5 shrink-0 text-[var(--ds-label-caption)]" aria-label="正在连接服务器" />
        )}
        {onCollapse && (
          <button
            type="button"
            aria-label="隐藏会话侧边栏"
            title="隐藏会话侧边栏 (⌘B)"
            className="window-no-drag flex size-7 shrink-0 items-center justify-center rounded-[8px] text-label-2 transition-colors hover:bg-hover hover:text-label-1"
            onClick={onCollapse}
          >
            <PanelLeftClose className="size-4" strokeWidth={1.8} />
          </button>
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

      <div className="flex shrink-0 flex-col gap-1 pb-3">
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
        <button
          type="button"
          className="flex min-h-9 w-full items-center gap-2 rounded-[12px] px-2 py-[7px] text-left text-[14px] leading-[22px] text-label-1 transition-colors hover:bg-hover"
          onClick={() => setAddOpen(true)}
        >
          <FolderPlus className="size-4 shrink-0 text-label-3" strokeWidth={1.8} />
          <span className="min-w-0 flex-1 truncate">创建工作区</span>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        <div className="flex h-8 items-center px-2 text-[12px] font-medium leading-5 text-label-3">
          项目
        </div>
        {projects.length === 0 && (
          <div className="px-2 py-4 text-[13px] leading-5 text-label-3">
            暂无工作区
          </div>
        )}
        {projects.map((project) => (
          <div key={project.id}>
            <div className="group flex h-[34px] items-center gap-1.5 rounded-[12px] px-2 text-[14px] leading-5 text-label-1 transition-colors hover:bg-hover">
              <Folder className="size-3.5 shrink-0 text-[var(--ds-label-caption)]" strokeWidth={1.8} />
              <span className="min-w-0 flex-1 truncate">
                {project.name}
              </span>
              <button
                type="button"
                aria-label={`移除工作区 ${project.name}`}
                title="移除工作区"
                className="flex size-4 shrink-0 items-center justify-center rounded-[4px] text-label-3 opacity-100 transition-colors hover:text-label-1 md:opacity-0 md:group-hover:opacity-100"
                onClick={() => setConfirmTarget({ kind: "project", id: project.id, name: project.name })}
              >
                <Trash2 className="size-3.5" strokeWidth={1.8} />
              </button>
            </div>
            {threadsByProject(project.id).map((thread) => {
              const active = location.pathname === `/thread/${thread.id}`;
              const running = runningIds.includes(thread.id);
              const canManageThread = thread.access === "owner";
              return (
                <div key={thread.id} className="group relative">
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
                      canManageThread ? "pr-8" : "pr-2",
                      active && "bg-hover",
                    )}
                  >
                    {running ? (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-[var(--ds-link)]" strokeWidth={1.8} />
                    ) : thread.access === "readonly" ? (
                      <Eye className="size-3.5 shrink-0 text-label-3" strokeWidth={1.8} />
                    ) : thread.access === "collaborate" ? (
                      <MessagesSquare className="size-3.5 shrink-0 text-label-3" strokeWidth={1.8} />
                    ) : (
                      <MessageSquare className="size-3.5 shrink-0 text-label-3" strokeWidth={1.8} />
                    )}
                    <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                  </Link>
                  {canManageThread && (
                    <button
                      type="button"
                      className="absolute top-1/2 right-1.5 flex size-5 -translate-y-1/2 items-center justify-center rounded-[6px] text-label-3 opacity-100 transition-colors hover:bg-hover hover:text-label-1 md:opacity-0 md:group-hover:opacity-100"
                      aria-label={`删除会话 ${thread.title}`}
                      title="删除会话"
                      onClick={() => setConfirmTarget({ kind: "thread", id: thread.id, name: thread.title, active })}
                    >
                      <Trash2 className="size-3.5" strokeWidth={1.8} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        {sharedThreads.length > 0 && (
          <div className="mt-2">
            <div className="flex h-8 items-center gap-1.5 px-2 text-[12px] font-medium leading-5 text-label-3">
              <MessagesSquare className="size-3.5" strokeWidth={1.8} />
              共享会话
            </div>
            {sharedThreads.map((thread) => {
              const active = location.pathname === `/thread/${thread.id}`;
              const running = runningIds.includes(thread.id);
              return (
                <Link
                  key={thread.id}
                  to={`/thread/${thread.id}`}
                  onClick={onNavigate}
                  className={cn(
                    "flex h-8 items-center gap-1.5 rounded-[12px] px-2 text-[14px] leading-5 text-label-1 transition-colors hover:bg-hover",
                    active && "bg-hover",
                  )}
                >
                  {running ? (
                    <Loader2 className="size-3.5 shrink-0 animate-spin text-[var(--ds-link)]" strokeWidth={1.8} />
                  ) : thread.access === "readonly" ? (
                    <Eye className="size-3.5 shrink-0 text-label-3" strokeWidth={1.8} />
                  ) : (
                    <MessagesSquare className="size-3.5 shrink-0 text-label-3" strokeWidth={1.8} />
                  )}
                  <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                </Link>
              );
            })}
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
        title={confirmTarget?.kind === "project" ? "移除工作区？" : "删除会话？"}
        description={
          confirmTarget?.kind === "project"
            ? `将移除“${confirmTarget.name}”，不会删除磁盘文件。`
            : `会话“${confirmTarget?.name ?? ""}”及其历史记录将被删除。`
        }
        confirmLabel={confirmTarget?.kind === "project" ? "移除" : "删除"}
        destructive
        onConfirm={() => {
          if (confirmTarget?.kind === "project") {
            void removeWorkspace(confirmTarget.id);
          } else if (confirmTarget?.kind === "thread") {
            void deleteThread(confirmTarget.id);
            if (confirmTarget.active) {
              navigate("/");
              onNavigate?.();
            }
          }
          setConfirmTarget(null);
        }}
      />
    </aside>
  );
}
