import { Outlet } from "react-router-dom";
import { NavRail } from "./NavRail";
import { WindowControls } from "./WindowControls";

/**
 * The application shell is intentionally limited to CCA's left navigation.
 * Every other surface is owned by the embedded DeepSeek Harness UI.
 */
export function AppLayout() {
  return (
    <div className="relative flex h-dvh overflow-hidden bg-background">
      <div className="hidden h-full min-h-0 shrink-0 md:flex">
        <NavRail />
      </div>
      <div className="flex h-full min-h-0 w-[3.25rem] shrink-0 md:hidden">
        <NavRail />
      </div>
      <WindowControls show="windows" className="fixed right-1 top-1 z-50" />
      <main className="relative flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
