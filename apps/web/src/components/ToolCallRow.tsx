import { useMemo, useState, type KeyboardEvent } from "react";
import {
  Brain,
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

export type ToolKind = "reasoning" | "modify" | "read" | "search" | "command" | "web" | "other";

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

/** 每种工具在行首显示的动作名(对应 harness 的用例标题)。 */
export const TOOL_LABELS: Record<ToolKind, string> = {
  reasoning: "思考",
  modify: "编辑文件",
  read: "读取文件",
  search: "搜索代码",
  command: "运行命令",
  web: "访问网页",
  other: "调用工具",
};

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

export function toolKind(activity: ToolActivity): ToolKind {
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

/** 按调用次数排序，同次数保留首次出现的顺序。 */
export function toolCategoryKinds(activities: readonly ToolActivity[]): ToolKind[] {
  const counts = new Map<ToolKind, number>();
  const seen = new Set<string>();
  for (const activity of activities) {
    if (seen.has(activity.id)) continue;
    seen.add(activity.id);
    const kind = toolKind(activity);
    if (kind === "reasoning") continue;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.keys()].sort((left, right) => counts.get(right)! - counts.get(left)!);
}

export function processToolTitle(kinds: readonly ToolKind[], hasSubagents = false): string {
  const labels: Record<ToolKind, string> = {
    reasoning: "已完成分析", modify: "修改了文件", read: "已读取文件", search: "已搜索代码",
    command: "执行了命令", web: "已访问网页", other: "已调用工具",
  };
  const titles = kinds.map((kind) => labels[kind]);
  if (hasSubagents) titles.push("已协调子代理");
  if (titles.length === 0) return "已完成分析";
  if (titles.length === 1) return titles[0]!;
  if (titles.length === 2) {
    const [first, second] = titles as [string, string];
    return `${first}并${first.startsWith("已") && second.startsWith("已") ? second.slice(1) : second}`;
  }
  return `${titles.slice(0, 3).join("，")}${titles.length > 3 ? "等" : ""}`;
}

export function toolCategoryLabels(activities: readonly ToolActivity[]): string[] {
  return toolCategoryKinds(activities).map((kind) => TOOL_LABELS[kind]);
}

export function liveToolLabel(activity: ToolActivity): string {
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

export function ToolKindIcon({ kind, className }: { kind: ToolKind; className?: string }) {
  const iconClassName = cn("block size-3.5 shrink-0 stroke-[1.8]", className);
  if (kind === "reasoning") return <Brain className={iconClassName} />;
  if (kind === "modify") return <SquarePen className={iconClassName} />;
  if (kind === "read") return <Eye className={iconClassName} />;
  if (kind === "search") return <Search className={iconClassName} />;
  if (kind === "command") return <Terminal className={iconClassName} />;
  if (kind === "web") return <Globe2 className={iconClassName} />;
  return <Wrench className={iconClassName} />;
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "");
}

function formatPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function firstLine(text: string, limit = 160): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

function lineCount(text: string): number {
  return text.split("\n").length;
}

/** 工具卡片外壳:与 harness TerminalBlock/IO 卡片同款圆角与底色。 */
function ToolCard({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-1 ml-1 overscroll-contain overflow-hidden rounded-[16px] border-[0.5px] border-line-1 bg-code">
      {children}
    </div>
  );
}

function CardHeader({ prefix, title, meta }: { prefix?: string; title: string; meta?: string }) {
  return (
    <div className="flex items-start gap-2 px-3.5 py-2.5 font-mono text-[12px] leading-[20px]">
      {prefix && <span className="shrink-0 select-none text-label-3">{prefix}</span>}
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-label-1">{title}</span>
      {meta && <span className="shrink-0 text-[11px] leading-5 text-label-3">{meta}</span>}
    </div>
  );
}

function CommandBody({ command, output, failed }: { command: string; output: string; failed: boolean }) {
  return (
    <ToolCard>
      <CardHeader prefix="$" title={command} meta={output ? `${lineCount(output)} 行输出` : undefined} />
      {output && (
        <>
          <div className="h-[0.5px] bg-line-2" />
          <pre
            className={cn(
              "max-h-[224px] overflow-auto whitespace-pre-wrap break-words px-3.5 py-2.5 font-mono text-[12px] leading-[18px]",
              failed ? "text-destructive" : "text-label-2",
            )}
          >
            {output}
          </pre>
        </>
      )}
    </ToolCard>
  );
}

function ReadBody({ path, content, failed }: { path: string; content: string; failed: boolean }) {
  const lines = content.split("\n");
  const shown = lines.slice(0, 120);
  return (
    <ToolCard>
      <CardHeader title={path} meta={`${lines.length} 行`} />
      <div className="h-[0.5px] bg-line-2" />
      <div className="max-h-[260px] overflow-auto px-3.5 py-2.5 font-mono text-[12px] leading-[18px]">
        {shown.map((line, index) => (
          <div key={index} className="flex min-w-0">
            <span className="w-9 shrink-0 select-none pr-3 text-right text-label-3 tabular-nums">
              {index + 1}
            </span>
            <span className={cn("min-w-0 whitespace-pre-wrap break-words", failed ? "text-destructive" : "text-label-1")}>
              {line || " "}
            </span>
          </div>
        ))}
        {lines.length > shown.length && (
          <div className="mt-1 pl-9 text-[11px] text-label-3">还有 {lines.length - shown.length} 行未显示</div>
        )}
      </div>
    </ToolCard>
  );
}

function TextBody({
  title,
  content,
  failed,
  mono = true,
  meta,
}: {
  title: string;
  content: string;
  failed: boolean;
  mono?: boolean;
  meta?: string;
}) {
  return (
    <ToolCard>
      <CardHeader title={title} meta={meta} />
      {content && (
        <>
          <div className="h-[0.5px] bg-line-2" />
          <div
            className={cn(
              "max-h-[260px] overflow-auto whitespace-pre-wrap break-words px-3.5 py-2.5",
              mono ? "font-mono text-[12px] leading-[18px]" : "text-[13px] leading-5",
              failed ? "text-destructive" : "text-label-2",
            )}
          >
            {content}
          </div>
        </>
      )}
    </ToolCard>
  );
}

function IoBody({ input, output, failed }: { input: string; output: string; failed: boolean }) {
  return (
    <ToolCard>
      <div className="grid max-h-[150px] grid-cols-[max-content_1fr] items-baseline gap-x-3.5 overflow-auto px-4 py-3 font-mono text-[12px] leading-[20px]">
        <span className="sticky top-0 self-start text-[11px] text-label-3">IN</span>
        <span className="min-w-0 whitespace-pre-wrap break-words text-label-2">{input}</span>
      </div>
      {output && (
        <>
          <div className="h-[0.5px] bg-line-2" />
          <div className="grid max-h-[150px] grid-cols-[max-content_1fr] items-baseline gap-x-3.5 overflow-auto px-4 py-3 font-mono text-[12px] leading-[20px]">
            <span className="sticky top-0 self-start text-[11px] text-label-3">OUT</span>
            <span className={cn("min-w-0 whitespace-pre-wrap break-words", failed ? "text-destructive" : "text-label-2")}>
              {output}
            </span>
          </div>
        </>
      )}
    </ToolCard>
  );
}

/** 一条工具调用:24px 摘要行 + 可展开的卡片正文。 */
export function ToolCallRow({ activity }: { activity: ToolActivity }) {
  const [expanded, setExpanded] = useState(false);
  const args = useMemo(() => parseArgs(activity.args), [activity.args]);
  const target = useMemo(() => toolTarget(args), [args]);
  const kind = toolKind(activity);
  const failed = activity.status === "error";
  const running = activity.status === "running";
  const output = stripAnsi((activity.result ?? "").trim());
  const caption = TOOL_LABELS[kind];
  const summary = failed
    ? firstLine(output) || `${activity.toolName} 调用失败`
    : target ?? (kind === "reasoning" ? firstLine(output) : activity.toolName);
  const canExpand = Boolean(output) || (args !== null && Object.keys(args).length > 0);
  const toggle = () => setExpanded((value) => !value);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  };

  const body = kind === "command"
    ? <CommandBody command={target ?? activity.toolName} output={output} failed={failed} />
    : kind === "read" && output
      ? <ReadBody path={target ?? activity.toolName} content={output} failed={failed} />
      : kind === "search" || kind === "web"
        ? <TextBody title={target ?? activity.toolName} content={output} failed={failed} />
        : (
          <IoBody
            input={activity.args?.trim() ? formatPayload(activity.args) : "（无参数）"}
            output={output}
            failed={failed}
          />
        );

  return (
    <div className="group/tool flex min-w-0 flex-col">
      <div
        {...(canExpand
          ? {
            role: "button" as const,
            tabIndex: 0,
            "aria-expanded": expanded,
            onClick: toggle,
            onKeyDown,
          }
          : {})}
        className={cn(
          "flex h-6 select-none items-center gap-1.5 rounded-[6px]",
          canExpand && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
        )}
      >
        <span
          className={cn(
            "relative flex size-4 shrink-0 items-center justify-center",
            failed ? "text-destructive" : "text-label-3",
          )}
        >
          <span className={cn(
            "transition-opacity duration-100",
            canExpand && (expanded ? "opacity-0" : "group-hover/tool:opacity-0 group-focus-within/tool:opacity-0"),
          )}>
            {failed ? <X className="size-3.5 stroke-[1.8]" /> : <ToolKindIcon kind={kind} />}
          </span>
          {canExpand && (
            <ChevronRight
              className={cn(
                "absolute size-3.5 transition-all duration-100",
                expanded
                  ? "rotate-90 opacity-100"
                  : "opacity-0 group-hover/tool:opacity-100 group-focus-within/tool:opacity-100",
              )}
            />
          )}
        </span>
        <span
          className={cn(
            "shrink-0 text-[13px] leading-6 transition-colors",
            failed ? "text-destructive" : "text-label-2 group-hover/tool:text-label-1",
            running && !failed && "text-shimmer",
          )}
        >
          {running ? liveToolLabel(activity) : caption}
        </span>
        {summary && (
          <>
            <span aria-hidden="true" className="mx-2 size-0.5 shrink-0 rounded-full bg-label-caption" />
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[13px] leading-6 transition-colors",
                failed ? "text-destructive" : "text-label-3 group-hover/tool:text-label-1",
              )}
            >
              {summary}
            </span>
          </>
        )}
      </div>
      {expanded && canExpand && body}
    </div>
  );
}
