import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  FolderGit2,
  FolderPlus,
  Eye,
  Loader2,
  LogOut,
  MessageSquare,
  MessagesSquare,
  Package,
  PanelLeftClose,
  Plus,
  Settings,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
  WifiOff,
  X,
} from "lucide-react";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";
import { Button, buttonVariants } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ProjectDirectoryPicker } from "./ProjectDirectoryPicker";
import { BrandLogo } from "./BrandLogo";

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
  const addProject = useApp((s) => s.addProject);
  const removeProject = useApp((s) => s.removeProject);
  const deleteThread = useApp((s) => s.deleteThread);
  const user = useApp((s) => s.user);
  const logout = useApp((s) => s.logout);
  const connected = useApp((s) => s.connected);
  const location = useLocation();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState<
    | { kind: "project"; id: string; name: string }
    | { kind: "thread"; id: string; name: string; active: boolean }
    | null
  >(null);

  const threadsByProject = (projectId: string) =>
    threads
      .filter((thread) => thread.projectId === projectId && !thread.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <aside className="flex h-full w-full shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 md:w-[17rem] md:rounded-lg md:border dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex h-12 items-center gap-2 px-4">
        <BrandLogo className="h-6 w-6" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">云端编码助手</span>
        {!connected && (
          <WifiOff className="h-3.5 w-3.5 text-amber-500" aria-label="正在连接服务器" />
        )}
        {onCollapse && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="隐藏会话侧边栏"
            title="隐藏会话侧边栏 (⌘B)"
            className="text-zinc-400"
            onClick={onCollapse}
          >
            <PanelLeftClose className="h-4 w-4" />
          </Button>
        )}
        {onClose && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="关闭侧栏"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      <div className="px-3 pb-2">
        <Button
          variant="outline"
          className="w-full justify-start bg-white dark:bg-zinc-950"
          onClick={() => {
            navigate("/");
            onNavigate?.();
          }}
        >
          <Plus className="h-4 w-4" /> 新会话
        </Button>
        {user?.role === "admin" && (
          <Button
            variant="ghost"
            className="mt-1 w-full justify-start text-muted-foreground"
            onClick={() => setAddOpen(true)}
          >
            <FolderPlus className="h-4 w-4" /> 添加项目目录
          </Button>
        )}
        {user?.role === "admin" && (
          <Link
            to="/skills"
            onClick={onNavigate}
            className={cn(
              buttonVariants({ variant: location.pathname === "/skills" ? "secondary" : "ghost" }),
              "mt-1 w-full justify-start",
              location.pathname !== "/skills" && "text-muted-foreground",
            )}
          >
            <Sparkles className="h-4 w-4" /> 技能
          </Link>
        )}
        {user?.role === "admin" && (
          <Link
            to="/plugins"
            onClick={onNavigate}
            className={cn(
              buttonVariants({ variant: location.pathname === "/plugins" ? "secondary" : "ghost" }),
              "mt-1 w-full justify-start",
              location.pathname !== "/plugins" && "text-muted-foreground",
            )}
          >
            <Package className="h-4 w-4" /> 插件市场
          </Link>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {projects.length === 0 && (
          <div className="px-2 py-6 text-center text-xs text-zinc-500">
            暂无项目目录
          </div>
        )}
        {projects.map((project) => (
          <div key={project.id} className="mt-3">
            <div className="group flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
              <FolderGit2 className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate" title={project.path}>
                {project.name}
              </span>
              {user?.role === "admin" && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="opacity-100 md:opacity-0 md:group-hover:opacity-100"
                  aria-label={`移除项目 ${project.name}`}
                  title="移除项目"
                  onClick={() => setConfirmTarget({ kind: "project", id: project.id, name: project.name })}
                >
                  <Trash2 className="h-3.5 w-3.5 text-zinc-400 hover:text-red-500" />
                </Button>
              )}
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
                      buttonVariants({ variant: active ? "secondary" : "ghost", size: "sm" }),
                      "w-full justify-start font-normal",
                      canManageThread ? "pr-9" : "pr-2",
                      active ? "font-medium" : "text-muted-foreground",
                    )}
                  >
                    {running ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
                    ) : thread.access === "readonly" ? (
                      <Eye className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    ) : thread.access === "collaborate" ? (
                      <MessagesSquare className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    ) : (
                      <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                  </Link>
                  {canManageThread && (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-100 md:opacity-0 md:group-hover:opacity-100"
                      aria-label={`删除会话 ${thread.title}`}
                      title="删除会话"
                      onClick={() => setConfirmTarget({ kind: "thread", id: thread.id, name: thread.title, active })}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-zinc-400 hover:text-red-500" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="border-t border-zinc-200 p-2 dark:border-zinc-800">
        <div className="mb-1 flex items-center gap-2 rounded-md px-2 py-1.5">
          <User className="h-4 w-4 shrink-0 text-zinc-400" />
          <span className="min-w-0 flex-1 truncate text-sm">{user?.username}</span>
          {user?.role === "admin" && (
            <span title="管理员">
              <ShieldCheck className="h-3.5 w-3.5 text-blue-500" />
            </span>
          )}
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="退出登录"
            title="退出登录"
            className="text-zinc-400 hover:text-red-500"
            onClick={() => {
              logout();
              navigate("/");
              onNavigate?.();
            }}
          >
            <LogOut className="h-4 w-4" />
          </Button>
        </div>
        <Link
          to="/settings/general"
          onClick={onNavigate}
          className={cn(
            buttonVariants({
              variant: location.pathname.startsWith("/settings") ? "secondary" : "ghost",
              size: "default",
            }),
            "w-full justify-start",
            !location.pathname.startsWith("/settings") && "text-muted-foreground",
          )}
        >
          <Settings className="h-4 w-4" /> 设置
        </Link>
      </div>

      {addOpen && (
        <ProjectDirectoryPicker onClose={() => setAddOpen(false)} onAdd={(projectPath) => addProject(projectPath)} />
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => !open && setConfirmTarget(null)}
        title={confirmTarget?.kind === "project" ? "移除项目目录？" : "删除会话？"}
        description={
          confirmTarget?.kind === "project"
            ? `将移除“${confirmTarget.name}”，不会删除磁盘文件。`
            : `会话“${confirmTarget?.name ?? ""}”及其历史记录将被删除。`
        }
        confirmLabel={confirmTarget?.kind === "project" ? "移除" : "删除"}
        destructive
        onConfirm={() => {
          if (confirmTarget?.kind === "project") {
            void removeProject(confirmTarget.id);
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
