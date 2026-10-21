import { House, Package, PanelLeftOpen, Settings, Sparkles } from "lucide-react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";
import { WindowControls } from "./WindowControls";

type RailItem = {
  to: string;
  label: string;
  icon: typeof House;
  isActive: (pathname: string) => boolean;
};

function railItemClass(active: boolean) {
  return cn(
    "window-no-drag flex h-10 w-10 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
    active && "bg-zinc-200 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100",
  );
}

export function NavRail({
  onNavigate,
  sidebarCollapsed,
  onExpandSidebar,
}: {
  onNavigate?: () => void;
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
}) {
  const user = useApp((s) => s.user);
  const navigate = useNavigate();
  const { pathname } = useLocation();

  const items: RailItem[] = [
    {
      to: "/",
      label: "首页",
      icon: House,
      isActive: (p) => p === "/" || p.startsWith("/thread"),
    },
    ...(user?.role === "admin"
      ? [
          {
            to: "/skills",
            label: "技能",
            icon: Sparkles,
            isActive: (p: string) => p === "/skills",
          },
          {
            to: "/plugins",
            label: "扩展工具",
            icon: Package,
            isActive: (p: string) => p === "/plugins",
          },
        ]
      : []),
  ];

  const go = (to: string) => {
    navigate(to);
    onNavigate?.();
  };

  return (
    <nav
      className="relative z-10 flex h-full w-[3.25rem] shrink-0 flex-col items-center gap-1 border-r border-[rgba(15,23,42,0.05)] bg-zinc-100 py-2 shadow-[2px_0_10px_rgba(15,23,42,0.06)] dark:border-zinc-800 dark:bg-zinc-900 dark:shadow-[2px_0_10px_rgba(15,23,42,0.35)]"
      aria-label="主导航"
    >
      <div className="window-drag-region flex w-full shrink-0 items-center justify-center py-1">
        <WindowControls show="mac" />
      </div>
      {sidebarCollapsed && onExpandSidebar && (
        <button
          type="button"
          className={railItemClass(false)}
          aria-label="显示会话侧边栏"
          title="显示会话侧边栏 (⌘B)"
          onClick={onExpandSidebar}
        >
          <PanelLeftOpen className="h-4 w-4" />
        </button>
      )}
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          onClick={onNavigate}
          className={railItemClass(item.isActive(pathname))}
          aria-label={item.label}
          title={item.label}
        >
          <item.icon className="h-4 w-4" />
        </Link>
      ))}
      <div className="min-h-0 flex-1" />
      <button
        type="button"
        className={railItemClass(pathname.startsWith("/settings"))}
        aria-label="设置"
        title="设置"
        onClick={() => go("/settings/general")}
      >
        <Settings className="h-4 w-4" />
      </button>
    </nav>
  );
}
