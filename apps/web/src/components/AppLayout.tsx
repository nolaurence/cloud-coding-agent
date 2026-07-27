import { useEffect, useState } from "react";
import { Menu, PanelLeftOpen, PanelRightOpen, Share2, WifiOff } from "lucide-react";
import { Outlet, useLocation } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useApp } from "../lib/store";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { BrandLogo } from "./BrandLogo";

const SIDEBAR_COLLAPSED_STORAGE_KEY = "cloud-coding-agent:sidebar-collapsed";

function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function AppLayout() {
  const connected = useApp((s) => s.connected);
  const threads = useApp((s) => s.threads);
  const workspacePanelOpen = useApp((s) => s.workspacePanelOpen);
  const setWorkspacePanelOpen = useApp((s) => s.setWorkspacePanelOpen);
  const setShareDialogOpen = useApp((s) => s.setShareDialogOpen);
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  const toggleSidebarCollapsed = () =>
    setSidebarCollapsed((collapsed) => {
      const next = !collapsed;
      try {
        window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // localStorage 不可用时仅保留会话内状态
      }
      return next;
    });
  const threadPathMatch = location.pathname.match(/^\/thread\/([^/]+)$/);
  const routeThreadId = threadPathMatch?.[1]
    ? decodeURIComponent(threadPathMatch[1])
    : undefined;
  const routeThread = threads.find((thread) => thread.id === routeThreadId);
  const mobileTitle = routeThread?.title ?? "云端编码助手";
  const canManageThread = routeThread?.access === "owner";

  useEffect(() => {
    setSidebarOpen(false);
    setShareDialogOpen(false);
    if (!routeThreadId || !canManageThread) setWorkspacePanelOpen(false);
  }, [canManageThread, location.pathname, routeThreadId, setShareDialogOpen, setWorkspacePanelOpen]);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 768px)");
    const closeDesktopSheet = (event: MediaQueryListEvent | MediaQueryList) => {
      if (event.matches) setSidebarOpen(false);
    };
    closeDesktopSheet(desktop);
    desktop.addEventListener("change", closeDesktopSheet);
    return () => desktop.removeEventListener("change", closeDesktopSheet);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleSidebarCollapsed();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-dvh overflow-hidden bg-white dark:bg-zinc-950">
      {sidebarCollapsed ? (
        <div className="hidden shrink-0 md:block">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="显示会话侧边栏"
            title="显示会话侧边栏 (⌘B)"
            className="ml-[10px] mt-[10px] text-muted-foreground"
            onClick={toggleSidebarCollapsed}
          >
            <PanelLeftOpen className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <div className="m-[10px] hidden min-h-0 shrink-0 md:block">
          <Sidebar onCollapse={toggleSidebarCollapsed} />
        </div>
      )}

      <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
        <SheetContent
          side="left"
          showCloseButton={false}
          className="w-[min(85vw,18rem)] max-w-none gap-0 p-0 md:hidden sm:max-w-none"
        >
          <SheetTitle className="sr-only">导航</SheetTitle>
          <Sidebar
            onNavigate={() => setSidebarOpen(false)}
            onClose={() => setSidebarOpen(false)}
          />
        </SheetContent>
      </Sheet>

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-200 px-3 md:hidden dark:border-zinc-800">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="打开侧栏"
            title="打开侧栏"
            className="text-muted-foreground"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-5 w-5" />
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <BrandLogo className="h-5 w-5" />
            <span className="truncate text-sm font-medium">{mobileTitle}</span>
          </div>
          {routeThreadId && canManageThread && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="分享会话"
                title="分享会话"
                className="text-muted-foreground"
                onClick={() => setShareDialogOpen(true)}
              >
                <Share2 className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="打开工作区面板"
                title="打开工作区面板"
                aria-controls="thread-workspace-panel"
                aria-expanded={workspacePanelOpen}
                className="text-muted-foreground"
                onClick={() => setWorkspacePanelOpen(true)}
              >
                <PanelRightOpen className="h-4 w-4" />
              </Button>
            </>
          )}
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
