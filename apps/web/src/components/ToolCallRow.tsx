import { useMemo, useState, type KeyboardEvent } from "react";
import {
  Brain,
  ChevronDown,
  ChevronRight,
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
import { Markdown } from "./Markdown";

type ToolKind = "reasoning" | "modify" | "read" | "search" | "command" | "web" | "other";

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
  if (/(reason|think|thought)/.test(name)) return "reasoning";
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
  reasoning: "思考过程",
  modify: "编辑文件",
  read: "读取文件",
  search: "搜索代码",
  command: "运行命令",
  web: "访问网页",
  other: "调用工具",
};

function ToolIcon({ kind, className }: { kind: ToolKind; className?: string }) {
  const iconClassName = cn("block size-3.5 shrink-0 stroke-[1.8]", className);
  if (kind === "reasoning") return <Brain className={iconClassName} />;
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
  if (kind === "reasoning") return `思考了 ${count} 次`;
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
  if (kind === "reasoning") return "正在思考";
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
    <div className="min-w-0">
      <button
        type="button"
        className="group/tool-group flex h-6 w-full cursor-pointer items-center gap-1.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
        aria-label={hasFailure ? `${label}，工具调用失败` : undefined}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span
          className={cn(
            "relative flex size-4 shrink-0 items-center justify-center",
            hasFailure ? "text-destructive" : "text-label-3",
          )}
          role={hasFailure ? "img" : undefined}
          aria-label={hasFailure ? "工具调用失败" : undefined}
        >
          {hasFailure ? (
            <X className="block size-3.5 shrink-0 stroke-[1.8]" aria-hidden />
          ) : (
            <span
              className={cn(
                "inline-flex transition-opacity duration-100",
                expanded ? "opacity-0" : "group-hover/tool-group:opacity-0",
              )}
            >
              <ToolIcon kind={iconKind} />
            </span>
          )}
          <ChevronRight
            className={cn(
              "absolute size-3.5 shrink-0 transition-all duration-100",
              expanded
                ? "rotate-90 opacity-100"
                : "opacity-0 group-hover/tool-group:opacity-100",
            )}
          />
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px] leading-6",
            hasFailure ? "text-destructive" : "text-label-2 group-hover/tool-group:text-label-1",
          )}
        >
          {label}
        </span>
      </button>
      {expanded ? (
        <div className="flex flex-col pb-1 pl-[22px] pt-1">
          {activities.map((activity) => (
            <ToolCallRow key={activity.id} activity={activity} isExpandedToolGroupEntry />
          ))}
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
  const displayText =
    kind === "reasoning" || rawPreview.toLowerCase() === heading.toLowerCase()
      ? heading
      : rawPreview;
  const reasoningText = kind === "reasoning" ? (activity.result?.trim() ?? "") : "";
  const body = expandedBody(activity);
  const canExpand = kind === "reasoning" ? Boolean(reasoningText) : body !== null;
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
        "group/tool flex flex-col",
        canExpand && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
      )}
      {...rowToggleProps}
    >
      <div className="flex h-6 select-none items-center gap-1.5">
        <span
          className={cn(
            "flex size-4 shrink-0 items-center justify-center",
            failed ? "text-destructive" : "text-label-3",
            !showEntryIcon && "invisible",
          )}
          role={failed ? "img" : undefined}
          aria-label={failed ? "工具调用失败" : undefined}
          aria-hidden={!showEntryIcon}
        >
          {failed ? (
            <X className="block size-3.5 shrink-0 stroke-[1.8]" aria-hidden />
          ) : (
            <ToolIcon kind={kind} />
          )}
        </span>
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-[13px] leading-6",
            failed
              ? "font-medium text-destructive"
              : "text-label-3 transition-colors group-hover/tool:text-label-2",
          )}
        >
          {displayText}
        </span>
        <ChevronDown
          className={cn(
            "size-3 shrink-0 text-label-caption transition-all duration-150",
            expanded ? "rotate-180 opacity-100" : "opacity-0 group-hover/tool:opacity-100",
            !canExpand && "invisible",
          )}
          aria-hidden
        />
      </div>
      {expanded && canExpand ? (
        <div
          className="mb-1 ml-[22px] cursor-default border-l border-line-2 pl-3 pt-0.5"
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {kind === "reasoning" ? (
            <div className="markdown-compact max-h-64 cursor-text overflow-auto select-text">
              <Markdown>{reasoningText}</Markdown>
            </div>
          ) : body ? (
            <pre className="max-h-64 cursor-text overflow-auto whitespace-pre-wrap break-words text-[12px] leading-5 text-label-2 select-text [font-family:var(--ds-font-mono)]">
              {body}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
