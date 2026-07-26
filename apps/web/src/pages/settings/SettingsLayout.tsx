import { NavLink, Outlet } from "react-router-dom";
import { Blocks, Cpu, Settings2, Sparkles, Users } from "lucide-react";
import { cn } from "../../lib/utils";
import { useApp } from "../../lib/store";
import { buttonVariants } from "@/components/ui/button";

const adminNav = [
  { to: "providers", label: "模型", icon: Cpu },
  { to: "mcp", label: "MCP 服务器", icon: Blocks },
  { to: "skills", label: "技能", icon: Sparkles },
];

export function SettingsLayout() {
  const user = useApp((state) => state.user);
  const navItems =
    user?.role === "admin"
      ? [
          { to: "general", label: "通用", icon: Settings2 },
          ...adminNav,
          { to: "users", label: "用户管理", icon: Users },
        ]
      : [{ to: "general", label: "通用", icon: Settings2 }];

  return (
    <div className="flex h-full flex-col sm:flex-row">
      <nav className="flex w-full shrink-0 gap-1 overflow-x-auto border-b border-zinc-200 p-2 sm:w-44 sm:flex-col sm:overflow-x-visible sm:border-r sm:border-b-0 sm:p-3 dark:border-zinc-800">
        <div className="mb-3 hidden px-2 text-xs font-semibold text-zinc-400 sm:block">设置</div>
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                buttonVariants({ variant: isActive ? "secondary" : "ghost", size: "sm" }),
                "shrink-0 justify-start sm:w-full",
                !isActive && "text-muted-foreground",
              )
            }
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div className="mx-auto max-w-2xl">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
