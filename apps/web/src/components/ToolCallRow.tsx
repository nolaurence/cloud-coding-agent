import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  FilePenLine,
  FileSearch,
  Globe2,
  Loader2,
  Search,
  SquareTerminal,
  Wrench,
  X,
} from "lucide-react";
import type { ToolActivity } from "@cca/protocol";
import { cn } from "../lib/utils";

type ToolKind = "modify" | "read" | "search" | "command" | "web" | "other";

const targetKeys = [
  "path",
  "filePath",
  "filename",
  "file",
  "command",
  "cmd",
  "query",
  "pattern",
  "url",
];

function parseArgs(raw?: string): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toolTarget(args: Record<string, unknown> | null): string | null {
  if (!args) return null;
  const records = [
    args,
    ...Object.values(args).filter(
      (value): value is Record<string, unknown> =>
        Boolean(value) && typeof value === "object" && !Array.isArray(value),
    ),
  ];
  for (const record of records) {
    for (const key of targetKeys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function toolKind(activity: ToolActivity, target: string | null): ToolKind {
  const name = activity.toolName.toLowerCase();
  if (/(edit|write|create|patch|replace|insert|delete|rename|move|apply)/.test(name)) {
    return "modify";
  }
  if (
    /(bash|shell|terminal|exec|command)/.test(name) &&
    target &&
    /(apply_patch|sed\s+-i|perl\s+-pi|\btee\b|\btouch\b|\bmkdir\b|\bmv\b|\bcp\b|\brm\b|>>|[^<]>[^>])/.test(
      target,
    )
  ) {
    return "modify";
  }
  if (/(grep|glob|search|find)/.test(name)) return "search";
  if (/(read|view|open_file|cat_file)/.test(name)) return "read";
  if (/(bash|shell|terminal|exec|command)/.test(name)) return "command";
  if (/(web|browser|fetch|http|url)/.test(name)) return "web";
  return "other";
}

const labels: Record<ToolKind, string> = {
  modify: "编辑文件",
  read: "读取文件",
  search: "搜索代码",
  command: "运行命令",
  web: "访问网页",
  other: "调用工具",
};

function ToolIcon({ kind }: { kind: ToolKind }) {
  const className = "h-3.5 w-3.5 shrink-0 stroke-[1.8]";
  if (kind === "modify") return <FilePenLine className={className} />;
  if (kind === "read") return <FileSearch className={className} />;
  if (kind === "search") return <Search className={className} />;
  if (kind === "command") return <SquareTerminal className={className} />;
  if (kind === "web") return <Globe2 className={className} />;
  return <Wrench className={className} />;
}

function formatPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function duration(activity: ToolActivity): string | null {
  if (!activity.endedAt) return null;
  const elapsed = Math.max(0, activity.endedAt - activity.startedAt);
  return elapsed < 1000 ? `${elapsed} ms` : `${(elapsed / 1000).toFixed(1)} 秒`;
}

function statusText(activity: ToolActivity): string {
  if (activity.status === "running") return "执行中";
  if (activity.status === "error") return "执行失败";
  return "已完成";
}

export function ToolCallRow({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(activity.status === "error");
  const args = useMemo(() => parseArgs(activity.args), [activity.args]);
  const target = useMemo(() => toolTarget(args), [args]);
  const kind = toolKind(activity, target);
  const elapsed = duration(activity);
  const canExpand = Boolean(activity.args || activity.result);

  useEffect(() => {
    if (activity.status === "error") setOpen(true);
  }, [activity.status]);

  return (
    <div
      className={cn(
        "flex flex-col rounded-md px-0.5 py-0.5 transition-colors",
        canExpand && "hover:bg-zinc-100/60 dark:hover:bg-zinc-900/60",
      )}
    >
      <button
        type="button"
        aria-expanded={canExpand ? open : undefined}
        aria-label={`${labels[kind]}，${statusText(activity)}`}
        className={cn(
          "flex min-h-5 w-full select-none items-center gap-1.5 text-left text-xs leading-5",
          canExpand ? "cursor-pointer" : "cursor-default",
        )}
        onClick={() => {
          if (canExpand) setOpen((value) => !value);
        }}
      >
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center",
            activity.status === "error" ? "text-red-500" : "text-zinc-500 dark:text-zinc-400",
          )}
        >
          <ToolIcon kind={kind} />
        </span>
        <span
          className={cn(
            "min-w-0 shrink-0 truncate font-medium",
            activity.status === "error"
              ? "text-red-700 dark:text-red-300"
              : "text-zinc-700 dark:text-zinc-200",
          )}
        >
          {labels[kind]}
        </span>
        <span className="mono min-w-0 flex-1 truncate text-zinc-400" title={target ?? activity.toolName}>
          {(target ?? activity.toolName).replace(/\s+/g, " ")}
        </span>
        <span className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-400">
          {canExpand && (
            <ChevronDown
              className={cn("h-3 w-3 transition-transform", open && "rotate-180")}
            />
          )}
        </span>
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center"
          title={statusText(activity)}
        >
          {activity.status === "running" ? (
            <Loader2 className="h-3 w-3 animate-spin text-zinc-400" />
          ) : activity.status === "complete" ? (
            <Check className="h-3 w-3 text-zinc-500 dark:text-zinc-400" />
          ) : (
            <X className="h-3 w-3 text-red-500" />
          )}
        </span>
      </button>

      {open && canExpand && (
        <div className="ml-7 mt-1 border-l border-zinc-200 pb-1 pl-3 dark:border-zinc-800">
          <div className="mb-1.5 flex flex-wrap items-center gap-x-3 text-[11px] text-zinc-400">
            <span className="mono">{activity.toolName}</span>
            {elapsed && <span>{elapsed}</span>}
          </div>
          {activity.args && (
            <div className="mb-2">
              <div className="mb-1 text-[11px] font-medium text-zinc-500">参数</div>
              <pre className="mono max-h-52 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-zinc-500 select-text dark:text-zinc-400">
                {formatPayload(activity.args)}
              </pre>
            </div>
          )}
          {activity.result && (
            <div>
              <div className="mb-1 text-[11px] font-medium text-zinc-500">
                {activity.status === "error" ? "错误" : "输出"}
              </div>
              <pre className="mono max-h-72 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-zinc-500 select-text dark:text-zinc-400">
                {formatPayload(activity.result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
