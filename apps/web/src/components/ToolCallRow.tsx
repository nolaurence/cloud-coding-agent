import { useMemo, useState, type KeyboardEvent } from "react";
import {
  ChevronDown,
  Eye,
  Globe2,
  Search,
  SquarePen,
  Terminal,
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

function toolKind(activity: ToolActivity): ToolKind {
  const name = activity.toolName.toLowerCase();
  if (/(bash|shell|terminal|exec|command)/.test(name)) return "command";
  if (/(edit|write|create|patch|replace|insert|delete|rename|move|apply)/.test(name)) {
    return "modify";
  }
  if (/(grep|glob|search|find|rg)/.test(name)) return "search";
  if (/(read|view|open_file|cat_file)/.test(name)) return "read";
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

function ToolIcon({ kind, className }: { kind: ToolKind; className?: string }) {
  const iconClassName = cn("block size-4 shrink-0 stroke-[1.8] opacity-70", className);
  if (kind === "modify") return <SquarePen className={iconClassName} />;
  if (kind === "read") return <Eye className={iconClassName} />;
  if (kind === "search") return <Search className={iconClassName} />;
  if (kind === "command") return <Terminal className={iconClassName} />;
  if (kind === "web") return <Globe2 className={iconClassName} />;
  return <Wrench className={iconClassName} />;
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

function summaryLabel(kind: ToolKind, count: number): string {
  if (kind === "modify") return `更改了 ${count} 个文件`;
  if (kind === "read") return `读取了 ${count} 个文件`;
  if (kind === "search") return `搜索了 ${count} 次代码`;
  if (kind === "command") return `运行了 ${count} 条命令`;
  if (kind === "web") return `搜索了 ${count} 次网页`;
  return `使用了 ${count} 次工具`;
}

function summarizeToolGroup(activities: readonly ToolActivity[]): {
  label: string;
  kind: ToolKind;
} {
  const grouped = new Map<ToolKind, number>();
  for (const activity of activities) {
    const kind = toolKind(activity);
    grouped.set(kind, (grouped.get(kind) ?? 0) + 1);
  }
  const summaries = [...grouped].map(([kind, count]) => summaryLabel(kind, count));
  const label = summaries.length < 2
    ? (summaries[0] ?? "")
    : summaries.length === 2
      ? `${summaries[0]}，以及${summaries[1]}`
      : `${summaries.slice(0, -1).join("，")}，以及${summaries.at(-1)}`;
  return {
    label,
    kind: grouped.size === 1 ? grouped.keys().next().value! : "other",
  };
}

function liveToolLabel(activity: ToolActivity): string {
  const kind = toolKind(activity);
  const args = parseArgs(activity.args);
  const target = toolTarget(args);
  if (kind === "command") {
    const program = target?.trim().match(/^(?:cd\s+[^&;]+\s*&&\s*)?([\w./-]+)/)?.[1];
    return program ? `正在运行 ${program.split("/").at(-1)}` : "正在运行命令";
  }
  if (kind === "modify") return "正在更改文件";
  if (kind === "read") return "正在读取文件";
  if (kind === "search") return "正在搜索代码";
  if (kind === "web") return "正在搜索网页";
  return "正在调用工具";
}

export function ToolCallGroup({
  activities,
  expanded,
  onToggle,
}: {
  activities: readonly ToolActivity[];
  expanded: boolean;
  onToggle: () => void;
}) {
  let latestRunning: ToolActivity | undefined;
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    if (activities[index]?.status === "running") {
      latestRunning = activities[index];
      break;
    }
  }
  const summary = summarizeToolGroup(activities);
  const hasFailure = activities.some((activity) => activity.status === "error");
  const label = latestRunning ? liveToolLabel(latestRunning) : summary.label;
  const iconKind = latestRunning ? toolKind(latestRunning) : summary.kind;

  return (
    <div className="pb-2">
      <button
        type="button"
        className="group/tool-group flex min-h-6 w-full cursor-pointer items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-sm leading-relaxed transition-colors duration-150 hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        aria-label={hasFailure ? `${label}，工具调用失败` : undefined}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center",
            hasFailure ? "text-destructive" : "text-icon-muted",
          )}
          role={hasFailure ? "img" : undefined}
          aria-label={hasFailure ? "工具调用失败" : undefined}
        >
          {hasFailure ? (
            <X className="size-4 shrink-0 stroke-[1.8] opacity-70" aria-hidden />
          ) : (
            <ToolIcon kind={iconKind} />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-secondary-label">{label}</span>
      </button>
      {expanded ? (
        <div className="-mx-1 px-1 py-0">
          <div className="space-y-px">
            {activities.map((activity) => (
              <ToolCallRow key={activity.id} activity={activity} isExpandedToolGroupEntry />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ToolCallRow({
  activity,
  isExpandedToolGroupEntry,
}: {
  activity: ToolActivity;
  isExpandedToolGroupEntry: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const args = useMemo(() => parseArgs(activity.args), [activity.args]);
  const target = useMemo(() => toolTarget(args), [args]);
  const kind = toolKind(activity);
  const heading = labels[kind];
  const rawPreview = (target ?? activity.toolName).replace(/\s+/g, " ");
  const displayText = rawPreview.toLowerCase() === heading.toLowerCase() ? heading : rawPreview;
  const body = expandedBody(activity);
  const canExpand = body !== null;
  const failed = activity.status === "error";
  const showEntryIcon = !isExpandedToolGroupEntry || failed;
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": failed ? `${displayText}，工具调用失败` : displayText,
        "aria-expanded": expanded,
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
        "flex flex-col rounded-md px-0.5 transition-colors",
        isExpandedToolGroupEntry ? "py-0" : "py-0.5",
        canExpand &&
          "cursor-pointer hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
      )}
      {...rowToggleProps}
    >
      <div className="flex select-none items-center gap-1.5 transition-[opacity,translate] duration-200">
        <span
          className={cn(
            "flex size-6 shrink-0 items-center justify-center",
            failed ? "text-destructive" : "text-icon-muted",
            !showEntryIcon && "invisible",
          )}
          role={failed ? "img" : undefined}
          aria-label={failed ? "工具调用失败" : undefined}
          aria-hidden={!showEntryIcon}
        >
          {failed ? (
            <X className="block size-4 shrink-0 stroke-[1.8] opacity-70" aria-hidden />
          ) : (
            <ToolIcon kind={kind} />
          )}
        </span>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <p className="flex min-w-0 w-full items-baseline gap-1.5 text-sm leading-relaxed">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  failed ? "font-medium text-destructive" : "text-secondary-label",
                )}
              >
                {displayText}
              </span>
            </p>
          </div>
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center",
              !canExpand && "invisible",
            )}
            aria-hidden
          >
            <ChevronDown
              className={cn(
                "size-3 shrink-0 text-icon-muted opacity-70 transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          </span>
        </div>
      </div>
      {expanded && canExpand && body ? (
        <div
          className="mt-1 ms-7 cursor-default border-s border-border/45 ps-3 pt-0.5"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-secondary-label select-text">
            {body}
          </pre>
        </div>
      ) : null}
    </div>
  );
}
