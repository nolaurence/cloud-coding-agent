import { CircleGauge, Database, Gauge } from "lucide-react";
import type { ContextUsage, RuntimeStats } from "@cca/protocol";

const compactTokens = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const exactTokens = new Intl.NumberFormat("en-US");

function formatSpeed(tokensPerSecond: number): string {
  const clamped = Math.max(0, tokensPerSecond);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1_000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

/** 与 DSH StatsPills 一致：整数或一位小数，非满命中不显示 100。 */
function formatCacheHit(cacheReadTokens: number, billedInputTokens: number): string | undefined {
  if (billedInputTokens <= 0) return undefined;
  if (cacheReadTokens >= billedInputTokens) return "100";
  const rounded = Math.round((cacheReadTokens / billedInputTokens) * 1000) / 10;
  return String(Math.min(rounded, 99.9));
}

function formatContextPercent(usage: ContextUsage | null | undefined): string | undefined {
  if (!usage || usage.maxTokens <= 0) return undefined;
  const ratio = Math.max(0, Math.min(usage.usedTokens / usage.maxTokens, 1));
  const percentage = ratio > 0 && ratio < 0.01 ? "<1" : String(Math.round(ratio * 100));
  return `${percentage}%`;
}

export function RuntimeStatsBar({
  stats,
  contextUsage,
}: {
  stats?: RuntimeStats | null;
  contextUsage?: ContextUsage | null;
}) {
  const billedInput = stats
    ? stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens
    : 0;
  const totalTokens = stats ? billedInput + stats.outputTokens : 0;
  const speed =
    stats && stats.decodeMs > 0 ? stats.decodeTokens / (stats.decodeMs / 1_000) : undefined;
  const cacheHit = stats ? formatCacheHit(stats.cacheReadTokens, billedInput) : undefined;
  const contextPercent = formatContextPercent(contextUsage);
  const hasActivity = Boolean(stats && stats.steps > 0);
  const hasUsage = totalTokens > 0;
  const ttftAverage =
    stats && stats.ttftSteps > 0 ? stats.ttftMs / stats.ttftSteps : undefined;

  if (!hasActivity && !hasUsage && !contextPercent) return null;

  const activityText = hasActivity && stats
    ? `${stats.turns} 轮 ${stats.steps} 步${speed !== undefined ? ` · ${formatSpeed(speed)} tok/s` : ""}`
    : undefined;
  const usageText = hasUsage && stats
    ? `${compactTokens.format(totalTokens)} tok${cacheHit !== undefined ? ` · 缓存命中 ${cacheHit}%` : ""}`
    : undefined;

  const activityTitle = stats
    ? [
        `模型用时 ${formatDuration(stats.llmMs)}`,
        `工具用时 ${formatDuration(stats.toolMs)}`,
        ttftAverage !== undefined ? `首 token 平均 ${formatDuration(ttftAverage)}` : undefined,
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;
  const usageTitle = stats
    ? [
        `未缓存输入 ${exactTokens.format(stats.inputTokens)}`,
        `缓存读取 ${exactTokens.format(stats.cacheReadTokens)}`,
        `缓存写入 ${exactTokens.format(stats.cacheWriteTokens)}`,
        `输出 ${exactTokens.format(stats.outputTokens)}`,
      ].join(" · ")
    : undefined;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 text-[11px] leading-4 text-muted-foreground tabular-nums"
      data-dsh-stats=""
    >
      {activityText && (
        <span className="inline-flex min-w-0 items-center gap-1" title={activityTitle}>
          <Gauge className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{activityText}</span>
        </span>
      )}
      {usageText && (
        <span className="inline-flex min-w-0 items-center gap-1" title={usageTitle}>
          <Database className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{usageText}</span>
        </span>
      )}
      {contextPercent && (
        <span
          className="ml-auto inline-flex shrink-0 items-center gap-1"
          title={`上下文已使用 ${exactTokens.format(contextUsage?.usedTokens ?? 0)} / ${exactTokens.format(contextUsage?.maxTokens ?? 0)} 个 token`}
        >
          <CircleGauge className="size-3.5 shrink-0" aria-hidden="true" />
          <span>{contextPercent}</span>
        </span>
      )}
    </div>
  );
}
