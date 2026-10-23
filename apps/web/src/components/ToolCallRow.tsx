import { useMemo, useState, type KeyboardEvent } from "react";
import {
  Brain,
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
import { Markdown } from "./Markdown";
import "./tool-call.css";

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
  const iconClassName = cn("block size-3.5 shrink-0 stroke-[1.8] opacity-70", className);
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
    <div className="chat-tool-group" data-running={latestRunning ? "true" : undefined}>
      <button
        type="button"
        className="chat-disclosure-row"
        aria-label={hasFailure ? `${label}，工具调用失败` : undefined}
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span
          className={cn(
            "chat-disclosure-leading",
            hasFailure ? "text-destructive" : "text-icon-muted",
            latestRunning && !hasFailure && "text-sky-600 dark:text-sky-400",
          )}
          role={hasFailure ? "img" : undefined}
          aria-label={hasFailure ? "工具调用失败" : undefined}
        >
          {hasFailure ? (
            <X className="size-3.5 shrink-0 stroke-[1.8] opacity-70" aria-hidden />
          ) : (
            <ToolIcon kind={iconKind} />
          )}
        </span>
        <span className={cn("chat-disclosure-title", latestRunning && "chat-shimmer chat-shimmer--running")}>
          {label}
        </span>
        <ChevronDown className="chat-disclosure-chevron" aria-hidden />
      </button>
      {expanded ? (
        <div className="chat-tool-group-body">
          {activities.map((activity) => (
            <ToolCallRow key={activity.id} activity={activity} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToolCallRow({ activity }: { activity: ToolActivity }) {
  const [expanded, setExpanded] = useState(false);
  const args = useMemo(() => parseArgs(activity.args), [activity.args]);
  const target = useMemo(() => toolTarget(args), [args]);
  const kind = toolKind(activity);
  const heading = labels[kind];
  const rawPreview = (target ?? activity.toolName).replace(/\s+/g, " ");
  const displayText =
    kind === "reasoning" || rawPreview.toLowerCase() === heading.toLowerCase()
      ? ""
      : rawPreview;
  const reasoningText = kind === "reasoning" ? (activity.result?.trim() ?? "") : "";
  const input = activity.args?.trim() ? formatPayload(activity.args) : "";
  const output = activity.result?.trim() ? formatPayload(activity.result) : "";
  const canExpand = kind === "reasoning" ? Boolean(reasoningText) : Boolean(input || output);
  const failed = activity.status === "error";
  const running = activity.status === "running";
  const rowToggleProps = canExpand
    ? {
        role: "button" as const,
        tabIndex: 0 as const,
        "aria-label": failed
          ? `${heading}${displayText ? `：${displayText}` : ""}，工具调用失败`
          : `${heading}${displayText ? `：${displayText}` : ""}`,
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
      className="chat-tool-row"
      data-error={failed ? "true" : undefined}
    >
      <div
        className={cn("chat-disclosure-row select-none", canExpand && "cursor-pointer")}
        {...rowToggleProps}
      >
        <span
          className={cn(
            "chat-disclosure-leading",
            failed ? "text-destructive" : "text-icon-muted",
            running && !failed && "text-sky-600 dark:text-sky-400",
          )}
          role={failed ? "img" : undefined}
          aria-label={failed ? "工具调用失败" : undefined}
        >
          {failed ? (
            <X className="block size-3.5 shrink-0 stroke-[1.8] opacity-70" aria-hidden />
          ) : (
            <ToolIcon kind={kind} />
          )}
        </span>
        <span className={cn("chat-disclosure-title", running && "chat-shimmer chat-shimmer--running")}>
          {heading}
        </span>
        {displayText && (
          <>
            <span className="chat-disclosure-sep" aria-hidden />
            <span className="chat-disclosure-summary" title={displayText}>{displayText}</span>
          </>
        )}
        {canExpand && <ChevronDown className="chat-disclosure-chevron" aria-hidden />}
      </div>
      {expanded && canExpand ? (
        kind === "reasoning" ? (
          <div className="chat-tool-reasoning cursor-text select-text">
            <Markdown>{reasoningText}</Markdown>
          </div>
        ) : (
          <div className="chat-tool-io cursor-text select-text">
            {input && (
              <div className="chat-tool-io-section">
                <span className="chat-tool-io-label">输入</span>
                <pre>{input}</pre>
              </div>
            )}
            {input && output && <div className="chat-tool-io-divider" aria-hidden />}
            {output && (
              <div className="chat-tool-io-section" data-error={failed ? "true" : undefined}>
                <span className="chat-tool-io-label">{failed ? "错误" : "输出"}</span>
                <pre>{output}</pre>
              </div>
            )}
          </div>
        )
      ) : null}
    </div>
  );
}
