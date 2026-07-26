import type { ResizableWidthHandlers } from "../hooks/useResizableWidth";
import { cn } from "../lib/utils";

export function RightPanelResizeHandle({
  handlers,
  width,
  minWidth,
  maxWidth,
  resizing,
}: {
  handlers: ResizableWidthHandlers;
  width: number;
  minWidth: number;
  maxWidth: number;
  resizing: boolean;
}) {
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label="调整工作区面板宽度"
      aria-controls="thread-workspace-panel"
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={Math.round(width)}
      aria-valuetext={`${Math.round(width)} 像素`}
      title="拖动调整面板宽度；双击恢复默认宽度"
      className="group relative hidden w-2 shrink-0 touch-none cursor-col-resize select-none lg:block"
      {...handlers}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border transition-colors group-hover:bg-ring group-focus-visible:bg-ring",
          resizing && "w-0.5 bg-ring",
        )}
      />
    </div>
  );
}
