import { Link, Outlet } from "react-router-dom";
import { WindowControls } from "./WindowControls";

/**
 * Admin surface shell. The product's main workspace is the full-page DSH UI at
 * /dsh/; this layout only wraps CCA-owned settings pages.
 */
export function AppLayout() {
  return (
    <div className="relative flex h-dvh overflow-hidden bg-background">
      <WindowControls show="windows" className="fixed right-1 top-1 z-50" />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border/60 px-3 text-xs text-muted-foreground">
          <Link to="/" className="transition-colors hover:text-foreground">
            返回工作台
          </Link>
          <span className="text-border">/</span>
          <span>Kloud Work 设置</span>
        </div>
        <div className="relative min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
