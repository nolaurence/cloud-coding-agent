import type { ReactElement } from "react";
import { Download, Trash2 } from "lucide-react";
import { ContextMenu } from "radix-ui";

export function FileContextMenu({
  children,
  enabled = true,
  editable,
  busy,
  onDownload,
  onDelete,
}: {
  children: ReactElement;
  enabled?: boolean;
  editable: boolean;
  busy: boolean;
  onDownload: () => void;
  onDelete: () => void;
}) {
  if (!enabled) return children;
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-36 rounded-md border border-zinc-200 bg-white p-1 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <ContextMenu.Item
            disabled={busy}
            onSelect={onDownload}
            className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 outline-none data-disabled:pointer-events-none data-disabled:opacity-40 data-highlighted:bg-zinc-100 dark:data-highlighted:bg-zinc-800"
          >
            <Download className="h-3.5 w-3.5" />下载
          </ContextMenu.Item>
          <ContextMenu.Item
            disabled={!editable || busy}
            onSelect={onDelete}
            className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-red-600 outline-none data-disabled:pointer-events-none data-disabled:opacity-40 data-highlighted:bg-red-50 dark:text-red-400 dark:data-highlighted:bg-red-950/40"
          >
            <Trash2 className="h-3.5 w-3.5" />删除
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
