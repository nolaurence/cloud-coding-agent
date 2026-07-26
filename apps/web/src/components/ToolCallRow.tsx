import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  FilePenLine,
  FileSearch,
  Globe2,
  Loader2,
  Search,
  SquareTerminal,
  Wrench,
  XCircle,
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

const labels: Record<ToolKind, { running: string; complete: string; error: string }> = {
  modify: { running: "正在修改文件", complete: "文件已修改", error: "文件修改失败" },
  read: { running: "正在读取文件", complete: "文件已读取", error: "文件读取失败" },
  search: { running: "正在搜索代码", complete: "代码搜索完成", error: "代码搜索失败" },
  command: { running: "正在执行命令", complete: "命令执行完成", error: "命令执行失败" },
  web: { running: "正在访问网页", complete: "网页访问完成", error: "网页访问失败" },
  other: { running: "正在调用工具", complete: "工具调用完成", error: "工具调用失败" },
};

function ToolIcon({ kind }: { kind: ToolKind }) {
  const className = "h-4 w-4 shrink-0";
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

export function ToolCallRow({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(activity.status === "error");
  const args = useMemo(() => parseArgs(activity.args), [activity.args]);
  const target = useMemo(() => toolTarget(args), [args]);
  const kind = toolKind(activity, target);
  const elapsed = duration(activity);
  const statusLabel = labels[kind][activity.status];

  useEffect(() => {
    if (activity.status === "error") setOpen(true);
  }, [activity.status]);

  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border text-xs",
        activity.status === "error"
          ? "border-red-200 bg-red-50/70 dark:border-red-950 dark:bg-red-950/20"
          : "border-zinc-200 bg-zinc-50/80 dark:border-zinc-800 dark:bg-zinc-900/70",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform",
            open && "rotate-90",
          )}
        />
        <span
          className={cn(
            "shrink-0",
            activity.status === "error"
              ? "text-red-500"
              : kind === "modify" && activity.status === "complete"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-zinc-500 dark:text-zinc-400",
          )}
        >
          <ToolIcon kind={kind} />
        </span>
        <span className="shrink-0 font-medium text-zinc-700 dark:text-zinc-200">{statusLabel}</span>
        {target && (
          <span className="mono min-w-0 flex-1 truncate text-zinc-500 dark:text-zinc-400" title={target}>
            {target.replace(/\s+/g, " ")}
          </span>
        )}
        {!target && <span className="min-w-0 flex-1 truncate text-zinc-400">{activity.toolName}</span>}
        {activity.status === "running" ? (
          <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-blue-500" />
        ) : activity.status === "complete" ? (
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        ) : (
          <XCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
        )}
      </button>

      {open && (
        <div className="space-y-3 border-t border-zinc-200 px-3 py-3 dark:border-zinc-800">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
            <span>
              工具：<span className="mono text-zinc-700 dark:text-zinc-300">{activity.toolName}</span>
            </span>
            {elapsed && <span>耗时：{elapsed}</span>}
          </div>
          {activity.args && (
            <div>
              <div className="mb-1 font-medium text-zinc-500">调用参数</div>
              <pre className="mono max-h-52 overflow-auto rounded-md bg-white p-2.5 leading-5 break-all whitespace-pre-wrap dark:bg-zinc-950">
                {formatPayload(activity.args)}
              </pre>
            </div>
          )}
          {activity.result && (
            <div>
              <div className="mb-1 font-medium text-zinc-500">
                {activity.status === "error" ? "错误信息" : "执行输出"}
              </div>
              <pre className="mono max-h-72 overflow-auto rounded-md bg-white p-2.5 leading-5 break-all whitespace-pre-wrap dark:bg-zinc-950">
                {formatPayload(activity.result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
