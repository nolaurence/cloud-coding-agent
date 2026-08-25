import { useMemo, useState, type KeyboardEvent } from "react";
import {
  Check,
  ChevronDown,
  FilePenLine,
  FileSearch,
  Globe2,
  Minus,
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
  const className = "block size-3.5 shrink-0 stroke-[1.8] opacity-80";
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

function expandedBody(activity: ToolActivity): string | null {
  const blocks: string[] = [];
  if (activity.args?.trim()) blocks.push(`参数\n${formatPayload(activity.args)}`);
  if (activity.result?.trim()) {
    blocks.push(`${activity.status === "error" ? "错误" : "输出"}\n${formatPayload(activity.result)}`);
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

function statusText(activity: ToolActivity): string {
  if (activity.status === "running") return "执行中";
  if (activity.status === "error") return "执行失败";
  return "已完成";
}

export function ToolCallRow({ activity }: { activity: ToolActivity }) {
  const [expanded, setExpanded] = useState(false);
  const args = useMemo(() => parseArgs(activity.args), [activity.args]);
  const target = useMemo(() => toolTarget(args), [args]);
  const kind = toolKind(activity, target);
  const heading = labels[kind];
  const rawPreview = (target ?? activity.toolName).replace(/\s+/g, " ");
  const preview = rawPreview.toLowerCase() === heading.toLowerCase() ? null : rawPreview;
  const displayText = preview ? `${heading} - ${preview}` : heading;
  const body = expandedBody(activity);
  const canExpand = body !== null;
  const failed = activity.status === "error";
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-label": displayText,
        onClick: () => setExpanded((value) => !value),
        onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setExpanded((value) => !value);
          }
        },
      }
    : {};

  return (
    <div
      className={cn(
        "flex flex-col rounded-md px-0.5 py-0.5 transition-colors",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
      {...rowToggleProps}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground/65">
          <ToolIcon kind={kind} />
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex min-w-0 w-full items-baseline gap-1.5 text-[12px] leading-5">
              <span className="min-w-0 shrink truncate font-medium text-foreground/82">
                {heading}
              </span>
              {preview && (
                <span className="min-w-0 flex-1 truncate text-muted-foreground/55">{preview}</span>
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-px text-muted-foreground/55">
            <span className="flex size-4 shrink-0 items-center justify-center" aria-hidden={!canExpand}>
              {canExpand ? (
                <ChevronDown
                  className={cn(
                    "size-3 shrink-0 opacity-70 transition-transform duration-200",
                    expanded && "rotate-180",
                  )}
                  aria-hidden
                />
              ) : null}
            </span>
            <span
              className="flex size-4 shrink-0 items-center justify-center"
              title={statusText(activity)}
            >
              {failed ? (
                <X className="block size-3 shrink-0 text-destructive" aria-hidden />
              ) : activity.status === "complete" ? (
                <Check className="block size-3 shrink-0 stroke-current" aria-hidden />
              ) : (
                <Minus className="block size-3 shrink-0 opacity-70" aria-hidden />
              )}
            </span>
          </div>
        </div>
      </div>
      {expanded && canExpand && body ? (
        <div
          className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground select-text">
            {body}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
