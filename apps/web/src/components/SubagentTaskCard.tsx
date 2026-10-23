import { ArrowUpRight, Ban, Bot, Check, Loader2, Pause, X } from "lucide-react";
import type { SubagentActivity } from "@cca/protocol";

const numberFormatter = new Intl.NumberFormat("zh-CN", { notation: "compact" });

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.max(0, Math.round(milliseconds))} ms`;
  const seconds = Math.round(milliseconds / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分钟`;
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
  const status = subagentStatusText(subagent);

  return (
    <button
      type="button"
      data-subagent-id={subagent.id}
      className="group/subagent flex w-full min-w-0 items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-[12px] leading-5 transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-foreground/60"
      aria-label={`查看子代理任务：${subagentTaskTitle(subagent)}`}
      title={metadata ? `${status} · ${metadata}` : status}
      onClick={() => onOpen(subagent.id)}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground/65">
        <Bot className="h-3.5 w-3.5 stroke-[1.8]" />
      </span>
      <span className="min-w-0 flex-1 overflow-hidden">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 font-medium text-foreground/80">
            {subagent.agentDisplayName || "子代理"}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {subagentTaskTitle(subagent)}
          </span>
        </span>
      </span>
      {metadata && (
        <span className="hidden max-w-44 shrink truncate text-[11px] text-muted-foreground sm:block">
          {metadata}
        </span>
      )}
      <span className="flex h-4 shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
        <span className="hidden sm:inline">{status}</span>
        {subagent.status === "running" ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : subagent.status === "idle" ? (
          <Pause className="h-3 w-3 text-amber-600 dark:text-amber-400" />
        ) : subagent.status === "cancelled" ? (
          <Ban className="h-3 w-3 text-amber-600 dark:text-amber-400" />
        ) : subagent.status === "error" ? (
          <X className="h-3 w-3 text-destructive" />
        ) : (
          <Check className="h-3 w-3" />
        )}
      </span>
      <ArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground/30 transition-colors group-hover/subagent:text-muted-foreground/70" />
    </button>
  );
}
