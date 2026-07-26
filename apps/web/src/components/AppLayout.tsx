import { useEffect, useState } from "react";
import { Bot, Menu, WifiOff } from "lucide-react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useApp } from "../lib/store";

export function AppLayout() {
  const connected = useApp((s) => s.connected);
  const threads = useApp((s) => s.threads);
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const threadPathMatch = location.pathname.match(/^\/thread\/([^/]+)$/);
  const routeThreadId = threadPathMatch?.[1]
    ? decodeURIComponent(threadPathMatch[1])
    : undefined;
  const mobileTitle =
    threads.find((thread) => thread.id === routeThreadId)?.title ?? "云端编码助手";

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-dvh overflow-hidden bg-white dark:bg-zinc-950">
      <div className="hidden h-full md:block">
        <Sidebar />
      </div>

      {sidebarOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            aria-label="关闭侧栏"
            className="absolute inset-0 bg-black/45"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="relative h-full w-[min(85vw,18rem)] shadow-2xl">
            <Sidebar
              onNavigate={() => setSidebarOpen(false)}
              onClose={() => setSidebarOpen(false)}
            />
          </div>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200 px-3 md:hidden dark:border-zinc-800">
          <button
            type="button"
            aria-label="打开侧栏"
            title="打开侧栏"
            className="flex h-8 w-8 items-center justify-center rounded-md text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Bot className="h-4 w-4 shrink-0" />
            <span className="truncate text-sm font-medium">{mobileTitle}</span>
          </div>
          {!connected && (
            <span
              className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
              title="正在连接服务器"
            >
              <WifiOff className="h-3.5 w-3.5" />
              连接中
            </span>
          )}
        </header>
        <div className="relative min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
