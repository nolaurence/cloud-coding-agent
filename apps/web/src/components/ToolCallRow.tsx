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


function ToolRowContent({
  activity,
  kind,
  target,
  elapsed,
  status,
  canExpand,
  open,
}: {
  activity: ToolActivity;
  kind: ToolKind;
  target: string | null;
  elapsed: string | null;
  status: string;
  canExpand: boolean;
  open: boolean;
}) {
  return (
    <>
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border shadow-sm",
            activity.status === "error"
              ? "border-destructive/25 bg-destructive/10 text-destructive"
              : activity.status === "running"
                ? "border-border bg-background text-foreground/75"
                : "border-border/70 bg-muted/55 text-muted-foreground",
          )}
        >
          <ToolIcon kind={kind} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-[12px] font-semibold leading-5 text-foreground/85">
              {labels[kind]}
            </span>
            <span
              className="mono min-w-0 flex-1 truncate text-[11px] leading-5 text-muted-foreground"
              title={target ?? activity.toolName}
            >
              {(target ?? activity.toolName).replace(/\s+/g, " ")}
            </span>
          </span>
          <span className="flex items-center gap-1.5 text-[10px] leading-4 text-muted-foreground/80">
            <span>{activity.toolName}</span>
            {elapsed && <span>· {elapsed}</span>}
          </span>
        </span>
        <span
          className={cn(
            "flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[10px] font-medium",
            activity.status === "error"
              ? "bg-destructive/10 text-destructive"
              : activity.status === "running"
                ? "bg-foreground/5 text-foreground/75"
                : "bg-muted text-muted-foreground",
          )}
          title={status}
        >
          {activity.status === "running" ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : activity.status === "complete" ? (
            <Check className="h-3 w-3" />
          ) : (
            <X className="h-3 w-3" />
          )}
          <span className="hidden sm:inline">{status}</span>
        </span>
        <span className="flex h-6 w-5 shrink-0 items-center justify-center text-muted-foreground/70">
          {canExpand && (
            <ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform duration-200", open && "rotate-180")}
            />
          )}
        </span>
      </>
  );
}

export function ToolCallRow({ activity }: { activity: ToolActivity }) {
  const [open, setOpen] = useState(activity.status === "error");
  const args = useMemo(() => parseArgs(activity.args), [activity.args]);
  const target = useMemo(() => toolTarget(args), [args]);
  const kind = toolKind(activity, target);
  const elapsed = duration(activity);
  const canExpand = Boolean(activity.args || activity.result);
  const status = statusText(activity);

  useEffect(() => {
    if (activity.status === "error") setOpen(true);
  }, [activity.status]);

  return (
    <div className="group/tool flex flex-col py-1.5 first:pt-1 last:pb-1">
      {canExpand ? (
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${labels[kind]}，${status}`}
          className="flex min-h-9 w-full select-none items-center gap-2 rounded-lg px-1.5 text-left transition-colors hover:bg-accent/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/60"
          onClick={() => setOpen((value) => !value)}
        >
          <ToolRowContent
            activity={activity}
            kind={kind}
            target={target}
            elapsed={elapsed}
            status={status}
            canExpand
            open={open}
          />
        </button>
      ) : (
        <div
          className="flex min-h-9 w-full select-none items-center gap-2 rounded-lg px-1.5 text-left"
          aria-label={`${labels[kind]}，${status}`}
        >
          <ToolRowContent
            activity={activity}
            kind={kind}
            target={target}
            elapsed={elapsed}
            status={status}
            canExpand={false}
            open={false}
          />
        </div>
      )}

      {open && canExpand && (
        <div className="mx-1.5 mt-1.5 overflow-hidden rounded-lg border border-border/65 bg-background/75 shadow-sm">
          <div className="flex items-center justify-between border-b border-border/55 bg-muted/25 px-3 py-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            <span>调用详情</span>
            {elapsed && <span className="normal-case tracking-normal tabular-nums">{elapsed}</span>}
          </div>
          <div className="grid gap-3 p-3 md:grid-cols-2">
            {activity.args && (
              <section className={cn(!activity.result && "md:col-span-2")}>
                <div className="mb-1.5 text-[11px] font-semibold text-foreground/75">参数</div>
                <pre className="mono max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/45 p-2.5 text-[11px] leading-5 text-muted-foreground select-text">
                  {formatPayload(activity.args)}
                </pre>
              </section>
            )}
            {activity.result && (
              <section className={cn(!activity.args && "md:col-span-2")}>
                <div
                  className={cn(
                    "mb-1.5 text-[11px] font-semibold",
                    activity.status === "error" ? "text-destructive" : "text-foreground/75",
                  )}
                >
                  {activity.status === "error" ? "错误" : "输出"}
                </div>
                <pre className="mono max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/45 p-2.5 text-[11px] leading-5 text-muted-foreground select-text">
                  {formatPayload(activity.result)}
                </pre>
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
