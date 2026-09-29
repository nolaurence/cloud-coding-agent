import { Maximize2, Minus, X } from "lucide-react";
import { cn } from "../lib/utils";

type WindowControlsProps = {
  className?: string;
  show?: "auto" | "mac" | "windows";
};

export function WindowControls({ className, show = "auto" }: WindowControlsProps) {
  const desktop = window.ccaDesktop;
  if (!desktop?.windowControls) return null;

  const isMac = desktop.platform === "darwin";
  if ((show === "mac" && !isMac) || (show === "windows" && isMac)) return null;

  const controls = desktop.windowControls;
  return (
    <div
      className={cn(
        "window-controls window-no-drag flex shrink-0 items-center",
        isMac ? "window-controls-mac gap-2" : "window-controls-windows gap-0.5",
        className,
      )}
      role="group"
      aria-label="窗口控制"
    >
      {isMac ? (
        <>
          <button
            type="button"
            className="window-control-mac window-control-close"
            aria-label="关闭窗口"
            title="关闭窗口"
            onClick={() => void controls.close()}
          >
            <X aria-hidden="true" />
          </button>
          <button
            type="button"
            className="window-control-mac window-control-minimize"
            aria-label="最小化窗口"
            title="最小化窗口"
            onClick={() => void controls.minimize()}
          >
            <Minus aria-hidden="true" />
          </button>
          <button
            type="button"
            className="window-control-mac window-control-maximize"
            aria-label="最大化窗口"
            title="最大化窗口"
            onClick={() => void controls.toggleMaximize()}
          >
            <Maximize2 aria-hidden="true" />
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            className="window-control-windows"
            aria-label="最小化窗口"
            title="最小化窗口"
            onClick={() => void controls.minimize()}
          >
            <Minus aria-hidden="true" />
          </button>
          <button
            type="button"
            className="window-control-windows"
            aria-label="最大化或还原窗口"
            title="最大化或还原窗口"
            onClick={() => void controls.toggleMaximize()}
          >
            <Maximize2 aria-hidden="true" />
          </button>
          <button
            type="button"
            className="window-control-windows window-control-windows-close"
            aria-label="关闭窗口"
            title="关闭窗口"
            onClick={() => void controls.close()}
          >
            <X aria-hidden="true" />
          </button>
        </>
      )}
    </div>
  );
}
