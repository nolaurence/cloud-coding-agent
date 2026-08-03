import { Loader2, Sparkles } from "lucide-react";
import type { AgentMode } from "@cca/protocol";
import { cn } from "../lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function UltraModeToggle({
  mode,
  disabled = false,
  loading = false,
  onChange,
}: {
  mode: AgentMode;
  disabled?: boolean;
  loading?: boolean;
  onChange: (mode: AgentMode) => void;
}) {
  const enabled = mode === "ultra";
  const label = enabled ? "关闭 Ultra 模式" : "开启 Ultra 模式";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={enabled}
          disabled={disabled || loading}
          className={cn(
            "flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
            enabled
              ? "bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-950/60 dark:text-violet-300 dark:hover:bg-violet-900/70"
              : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100",
          )}
          onClick={() => onChange(enabled ? "standard" : "ultra")}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Sparkles className="h-3.5 w-3.5" />
          )}
          <span>Ultra</span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={8}
        className="max-w-72 leading-5"
      >
        提升至模型支持的最高推理强度，并主动使用子代理并行探索和复核。会增加耗时和 token 消耗。
      </TooltipContent>
    </Tooltip>
  );
}
