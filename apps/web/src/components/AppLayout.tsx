import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { useApp } from "../lib/store";

export function AppLayout() {
  const connected = useApp((s) => s.connected);
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="relative min-w-0 flex-1">
        {!connected && (
          <div className="absolute top-2 right-2 z-40 rounded-md bg-amber-100 px-2 py-1 text-xs text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
            正在连接服务器…
          </div>
        )}
        <Outlet />
      </main>
    </div>
  );
}
