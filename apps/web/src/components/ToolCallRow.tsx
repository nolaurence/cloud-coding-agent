import { useState } from "react";
import { CheckCircle2, ChevronRight, Loader2, Wrench, XCircle } from "lucide-react";
import type { ToolActivity } from "@cca/protocol";
import { cn } from "../lib/utils";

function toolLabel(activity: ToolActivity): string {
  const name = activity.toolName;
  try {
    if (activity.args) {
      const args = JSON.parse(activity.args) as Record<string, unknown>;
      const target =
        (args.path as string) ??
        (args.filePath as string) ??
        (args.command as string) ??
        (args.cmd as string) ??
        (args.query as string) ??
        (args.url as string);
      if (target) return `${name}: ${String(target).slice(0, 120)}`;
    }
  } catch {
    // ignore
  }
  return name;
}

export function ToolCallRow({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-zinc-200 bg-zinc-50 text-xs dark:border-zinc-800 dark:bg-zinc-900/60">
      <button
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform", open && "rotate-90")} />
        {activity.status === "running" ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
        ) : activity.status === "complete" ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-green-500" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
        )}
        <Wrench className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <span className="mono min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-300">
          {toolLabel(activity)}
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-200 px-3 py-2 dark:border-zinc-800">
          {activity.args && (
            <div>
              <div className="mb-0.5 font-medium text-zinc-400">参数</div>
              <pre className="mono max-h-48 overflow-auto rounded bg-zinc-100 p-2 break-all whitespace-pre-wrap dark:bg-zinc-950">
                {formatJson(activity.args)}
              </pre>
            </div>
          )}
          {activity.result && (
            <div>
              <div className="mb-0.5 font-medium text-zinc-400">结果</div>
              <pre className="mono max-h-64 overflow-auto rounded bg-zinc-100 p-2 break-all whitespace-pre-wrap dark:bg-zinc-950">
                {activity.result}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
