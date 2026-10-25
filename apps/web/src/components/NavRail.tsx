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
    "window-no-drag flex size-9 items-center justify-center rounded-[12px] text-label-2 transition-colors hover:bg-hover hover:text-label-1",
    active && "bg-hover text-label-1",
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
            label: "插件",
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
      className="flex h-full w-14 shrink-0 flex-col items-center gap-1 border-r border-[rgba(15,23,42,0.05)] bg-panel px-2.5 pt-1.5 pb-2 shadow-[inset_-2px_0_10px_rgba(15,23,42,0.06)] dark:border-zinc-800 dark:shadow-[inset_-2px_0_10px_rgba(0,0,0,0.7)]"
      aria-label="主导航"
    >
      <div className="window-drag-region flex w-full shrink-0 items-center justify-center pb-1">
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
          <PanelLeftOpen className="size-[18px]" strokeWidth={1.8} />
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
          <item.icon className="size-[18px]" strokeWidth={1.8} />
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
        <Settings className="size-[18px]" strokeWidth={1.8} />
      </button>
    </nav>
  );
}
