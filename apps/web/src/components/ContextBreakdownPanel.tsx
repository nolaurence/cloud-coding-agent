import type { ContextBreakdown, ContextUsage } from "@cca/protocol";

const compactTokens = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function percentOf(usage: ContextUsage): string {
  if (usage.maxTokens <= 0) return "0";
  const ratio = Math.max(0, Math.min(usage.usedTokens / usage.maxTokens, 1));
  return ratio > 0 && ratio < 0.01 ? "<1" : String(Math.round(ratio * 100));
}

function rowsOf(breakdown: ContextBreakdown) {
  return [
    { label: "系统提示词", tokens: breakdown.systemTokens, color: "bg-zinc-400 dark:bg-zinc-500" },
    { label: "工具定义", tokens: breakdown.toolsTokens, color: "bg-violet-400" },
    { label: "对话消息", tokens: breakdown.messageTokens, color: "bg-blue-500" },
  ];
}

export function ContextBreakdownPanel({ usage }: { usage: ContextUsage }) {
  const percent = percentOf(usage);
  const breakdown = usage.breakdown;
  const total = breakdown
    ? breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens
    : 0;
  const rows = breakdown ? rowsOf(breakdown) : [];
  return (
    <div className="w-64 space-y-2 text-xs">
      <div className="flex items-baseline gap-1.5">
        <span className="text-zinc-500 dark:text-zinc-400">上下文已用</span>
        <span className="font-medium text-zinc-900 dark:text-zinc-100">{percent}%</span>
        <span className="ml-auto tabular-nums text-zinc-500 dark:text-zinc-400">
          ~{compactTokens.format(usage.usedTokens).toLowerCase()} / {compactTokens.format(usage.maxTokens).toLowerCase()}
        </span>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" aria-hidden="true">
        {breakdown && total > 0 ? (
          rows.map((row) => (
            <span
              key={row.label}
              className={`h-full ${row.color}`}
              style={{ width: `${Math.max(0, (row.tokens / total) * 100)}%` }}
            />
          ))
        ) : (
          <span
            className="h-full bg-zinc-500"
            style={{ width: `${Math.max(0, Math.min(100, Number(percent) || 0))}%` }}
          />
        )}
      </div>
      {breakdown && total > 0 ? (
        <dl className="space-y-1 border-t border-zinc-200 pt-1.5 dark:border-zinc-800">
          {rows.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-3">
              <dt className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400">
                <span className={`size-2 rounded-[2px] ${row.color}`} aria-hidden="true" />
                {row.label}
              </dt>
              <dd className="tabular-nums text-zinc-900 dark:text-zinc-100">
                ~{compactTokens.format(row.tokens).toLowerCase()}
              </dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-zinc-500 dark:text-zinc-400">明细暂不可用</p>
      )}
    </div>
  );
}
