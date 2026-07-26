import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Bot,
  FolderGit2,
  FolderPlus,
  Loader2,
  LogOut,
  MessageSquare,
  Plus,
  Settings,
  ShieldCheck,
  Trash2,
  User,
  WifiOff,
  X,
} from "lucide-react";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";
import { Button } from "./ui/primitives";
import { ProjectDirectoryPicker } from "./ProjectDirectoryPicker";

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
  const addProject = useApp((s) => s.addProject);
  const removeProject = useApp((s) => s.removeProject);
  const deleteThread = useApp((s) => s.deleteThread);
  const user = useApp((s) => s.user);
  const logout = useApp((s) => s.logout);
  const connected = useApp((s) => s.connected);
  const location = useLocation();
  const navigate = useNavigate();
  const [addOpen, setAddOpen] = useState(false);

  const threadsByProject = (projectId: string) =>
    threads
      .filter((thread) => thread.projectId === projectId && !thread.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);

  return (
    <aside className="flex h-full w-[17rem] shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 md:rounded-xl md:border dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex h-12 items-center gap-2 px-4">
        <Bot className="h-5 w-5 text-zinc-800 dark:text-zinc-100" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">云端编码助手</span>
        {!connected && (
          <WifiOff className="h-3.5 w-3.5 text-amber-500" aria-label="正在连接服务器" />
        )}
        {onClose && (
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-800"
            aria-label="关闭侧栏"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
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
                <button
                  className="flex h-6 w-6 items-center justify-center rounded opacity-100 hover:bg-zinc-200 md:opacity-0 md:group-hover:opacity-100 dark:hover:bg-zinc-700"
                  aria-label={`移除项目 ${project.name}`}
                  title="移除项目"
                  onClick={() => {
                    if (confirm(`移除项目 ${project.name}？（不会删除磁盘文件）`)) {
                      void removeProject(project.id);
                    }
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5 text-zinc-400 hover:text-red-500" />
                </button>
              )}
            </div>
            {threadsByProject(project.id).map((thread) => {
              const active = location.pathname === `/thread/${thread.id}`;
              const running = runningIds.includes(thread.id);
              return (
                <div key={thread.id} className="group relative">
                  <Link
                    to={`/thread/${thread.id}`}
                    onClick={onNavigate}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 pr-9 text-sm",
                      active
                        ? "bg-zinc-200 font-medium dark:bg-zinc-800"
                        : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/60",
                    )}
                  >
                    {running ? (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
                    ) : (
                      <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-60" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                  </Link>
                  <button
                    className="absolute top-1/2 right-1.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded opacity-100 hover:bg-zinc-200 md:opacity-0 md:group-hover:opacity-100 dark:hover:bg-zinc-700"
                    aria-label={`删除会话 ${thread.title}`}
                    title="删除会话"
                    onClick={() => {
                      if (confirm("确认删除该会话？")) {
                        void deleteThread(thread.id);
                        if (active) {
                          navigate("/");
                          onNavigate?.();
                        }
                      }
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-zinc-400 hover:text-red-500" />
                  </button>
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
          <button
            title="退出登录"
            className="text-zinc-400 hover:text-red-500"
            onClick={() => {
              logout();
              navigate("/");
              onNavigate?.();
            }}
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
        {user?.role === "admin" && (
          <button
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/60"
            onClick={() => setAddOpen(true)}
          >
            <FolderPlus className="h-4 w-4" /> 添加项目目录
          </button>
        )}
        <Link
          to="/settings/general"
          onClick={onNavigate}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm",
            location.pathname.startsWith("/settings")
              ? "bg-zinc-200 font-medium dark:bg-zinc-800"
              : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/60",
          )}
        >
          <Settings className="h-4 w-4" /> 设置
        </Link>
      </div>

      {addOpen && (
        <ProjectDirectoryPicker onClose={() => setAddOpen(false)} onAdd={(projectPath) => addProject(projectPath)} />
      )}
    </aside>
  );
}
