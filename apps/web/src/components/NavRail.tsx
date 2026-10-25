import { House, Package, PanelLeftClose, PanelLeftOpen, Settings, Sparkles } from "lucide-react";
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
  onToggleSidebar,
}: {
  onNavigate?: () => void;
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
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
  const SidebarIcon = sidebarCollapsed ? PanelLeftOpen : PanelLeftClose;
  const sidebarToggleLabel = sidebarCollapsed ? "显示会话侧边栏" : "隐藏会话侧边栏";

  return (
    <nav
      className="flex h-full w-11 shrink-0 flex-col items-center gap-1 bg-panel px-1 pt-1.5 pb-2 max-md:border-r max-md:border-line-1 md:w-[52px] md:px-2"
      aria-label="主导航"
    >
      <div className="window-drag-region flex w-full shrink-0 items-center justify-center pb-1">
        <WindowControls show="mac" className="scale-[0.8]" />
      </div>
      {onToggleSidebar && (
        <button
          type="button"
          className={railItemClass(false)}
          aria-label={sidebarToggleLabel}
          aria-expanded={!sidebarCollapsed}
          title={`${sidebarToggleLabel} (⌘B)`}
          onClick={onToggleSidebar}
        >
          <SidebarIcon className="size-[18px]" strokeWidth={1.8} />
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
