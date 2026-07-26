import { NavLink, Outlet } from "react-router-dom";
import { Blocks, Cpu, Settings2, Sparkles } from "lucide-react";
import { cn } from "../../lib/utils";

const nav = [
  { to: "general", label: "通用", icon: Settings2 },
  { to: "providers", label: "模型", icon: Cpu },
  { to: "mcp", label: "MCP 服务器", icon: Blocks },
  { to: "skills", label: "技能", icon: Sparkles },
];

export function SettingsLayout() {
  return (
    <div className="flex h-full flex-col sm:flex-row">
      <nav className="flex w-full shrink-0 gap-1 overflow-x-auto border-b border-zinc-200 p-2 sm:block sm:w-44 sm:border-r sm:border-b-0 sm:p-3 dark:border-zinc-800">
        <div className="mb-3 hidden px-2 text-xs font-semibold text-zinc-400 sm:block">设置</div>
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              cn(
                "flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm",
                isActive
                  ? "bg-zinc-200 font-medium dark:bg-zinc-800"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800/60",
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
