import { ArrowUpRight, Ban, Bot, Check, Loader2, Pause, X } from "lucide-react";
import type { SubagentActivity } from "@cca/protocol";
import { cn } from "../lib/utils";

const numberFormatter = new Intl.NumberFormat("zh-CN", { notation: "compact" });

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`;
}

function agentTone(name: string) {
  const tones = [
    "bg-cyan-100 text-cyan-700 dark:bg-cyan-950 dark:text-cyan-300",
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
    "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  ];
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return tones[hash % tones.length] ?? tones[0];
}

export function subagentTaskTitle(subagent: SubagentActivity): string {
  return subagent.taskDescription || subagent.prompt || subagent.agentDescription || "委派任务";
}

export function subagentStatusText(subagent: SubagentActivity): string {
  if (subagent.status === "running") return "执行中";
  if (subagent.status === "idle") return "等待中";
  if (subagent.status === "cancelled") return "已取消";
  if (subagent.status === "error") return "执行失败";
  return "已完成";
}

export function SubagentTaskCard({
  subagent,
  onOpen,
}: {
  subagent: SubagentActivity;
  onOpen: (subagentId: string) => void;
}) {
  const duration = subagent.durationMs ?? (
    subagent.endedAt ? subagent.endedAt - subagent.startedAt : undefined
  );
  const metadata = [
    duration !== undefined ? formatDuration(duration) : undefined,
    subagent.totalToolCalls !== undefined ? `${subagent.totalToolCalls} 次工具调用` : undefined,
    subagent.totalTokens !== undefined ? `${numberFormatter.format(subagent.totalTokens)} token` : undefined,
  ].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      data-subagent-id={subagent.id}
      className={cn(
        "group/subagent flex w-full min-w-0 items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
        "border-zinc-200 bg-zinc-50/70 hover:border-zinc-300 hover:bg-zinc-100/80 dark:border-zinc-800 dark:bg-zinc-900/55 dark:hover:border-zinc-700 dark:hover:bg-zinc-900",
        subagent.status === "error" && "border-red-200 bg-red-50/60 hover:border-red-300 hover:bg-red-50 dark:border-red-950 dark:bg-red-950/20 dark:hover:border-red-900 dark:hover:bg-red-950/30",
        subagent.status === "cancelled" && "border-amber-200 bg-amber-50/60 hover:border-amber-300 hover:bg-amber-50 dark:border-amber-950 dark:bg-amber-950/20 dark:hover:border-amber-900 dark:hover:bg-amber-950/30",
      )}
      aria-label={`查看子代理任务：${subagentTaskTitle(subagent)}`}
      onClick={() => onOpen(subagent.id)}
    >
      <span className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-md", agentTone(subagent.agentName))}>
        <Bot className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-xs font-medium text-zinc-500 dark:text-zinc-400">
            {subagent.agentDisplayName || "子代理"}
          </span>
          <span className="min-w-0 truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
            {subagentTaskTitle(subagent)}
          </span>
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-400">
          <span>{subagentStatusText(subagent)}</span>
          {metadata && <span className="truncate">· {metadata}</span>}
        </span>
      </span>
      <span className="flex h-6 w-6 shrink-0 items-center justify-center text-zinc-400">
        {subagent.status === "running" ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : subagent.status === "idle" ? (
          <Pause className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
        ) : subagent.status === "cancelled" ? (
          <Ban className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
        ) : subagent.status === "error" ? (
          <X className="h-3.5 w-3.5 text-red-500" />
        ) : (
          <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
        )}
      </span>
      <ArrowUpRight className="h-3.5 w-3.5 shrink-0 text-zinc-300 transition-colors group-hover/subagent:text-zinc-600 dark:text-zinc-700 dark:group-hover/subagent:text-zinc-300" />
    </button>
  );
}
