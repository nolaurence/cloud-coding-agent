import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  Ban,
  Bot,
  Brain,
  Check,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Copy,
  Loader2,
  Pause,
  Sparkles,
  X,
} from "lucide-react";
import type { ChatMessage, SubagentActivity, ToolActivity } from "@cca/protocol";
import { useImageObjectUrl } from "../hooks/useImageObjectUrl";
import type { ImagePreviewTarget } from "../lib/imagePreview";
import { useApp, useThreadState } from "../lib/store";
import {
  deriveChatTimeline,
  deriveTurnContent,
  turnEndedAt,
  turnStartedAt,
  type ChatTimelineEntry,
} from "../lib/chatTimeline";
import { Markdown } from "./Markdown";
import {
  ToolCallRow,
  ToolKindIcon,
  liveToolLabel,
  processToolTitle,
  toolCategoryKinds,
  type ToolKind,
} from "./ToolCallRow";
import {
  SubagentTaskCard,
  subagentStatusText,
  subagentTaskTitle,
} from "./SubagentTaskCard";
import { cn } from "../lib/utils";

const shortTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
});

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (totalSeconds < 1) return "不到 1 秒";
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
}

function firstLine(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "";
  return line.replace(/^[#>*\-+\s]+/, "").slice(0, 160);
}

/** 对话流里的紧凑展开行：24px 行高、16px 图标槽、13px 次级文字。 */
function ReasoningBlock({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(streaming);

  useEffect(() => {
    setOpen(streaming);
  }, [streaming]);

  const preview = firstLine(text);

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        className="group/think flex h-6 w-full min-w-0 items-center gap-1.5 text-left"
        onClick={() => setOpen((value) => !value)}
      >
        <span className="relative flex size-4 shrink-0 items-center justify-center text-label-3">
          <Brain
            className={cn(
              "size-3.5 transition-opacity duration-100",
              (open ? "opacity-0" : "opacity-100 group-hover/think:opacity-0"),
            )}
            strokeWidth={1.8}
          />
          <ChevronRight
            className={cn(
              "absolute size-3.5 transition-transform duration-100",
              open ? "rotate-90 opacity-100" : "opacity-0 group-hover/think:opacity-100",
            )}
          />
        </span>
        <span
          className={cn(
            "shrink-0 text-[13px] leading-6 text-label-2",
            streaming && "text-shimmer",
          )}
        >
          {streaming ? "正在思考" : "思考"}
        </span>
        {preview && !open && (
          <>
            <span aria-hidden="true" className="mx-2 size-0.5 shrink-0 rounded-full bg-label-caption" />
            <span className="min-w-0 flex-1 truncate text-[13px] leading-6 text-label-3">
              {preview}
            </span>
          </>
        )}
      </button>
      {open && (
        <div className="markdown-compact min-w-0 pb-1 pl-[22px] pt-1">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
  );
}

/** 28px 的图标动作：对话流与气泡下方共用。 */
function IconAction({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={cn(
        "flex size-7 items-center justify-center rounded-[8px] text-label-3 transition-colors hover:bg-hover hover:text-label-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60",
        className,
      )}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function CopyAction({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <IconAction
      label={copied ? "已复制" : label}
      onClick={() => void copy()}
      className={className}
    >
      {copied ? <Check className="size-[15px]" /> : <Copy className="size-[15px]" />}
    </IconAction>
  );
}

function MessageTime({ at }: { at: number }) {
  const date = new Date(at);
  return (
    <time dateTime={date.toISOString()} title={date.toLocaleString("zh-CN")}>
      {shortTimeFormatter.format(date)}
    </time>
  );
}

const MessageContext = createContext<{
  threadId: string;
  shareToken?: string;
  showAuthors: boolean;
  onOpenImage?: (image: ImagePreviewTarget) => void;
}>({ threadId: "", showAuthors: false });

function MessageImage({
  id,
  name,
  threadId,
  shareToken,
}: {
  id: string;
  name: string;
  threadId: string;
  shareToken?: string;
}) {
  const { onOpenImage } = useContext(MessageContext);
  const image = { id, displayName: name, threadId, shareToken };
  const { src, loading, error } = useImageObjectUrl(image);

  if (error) {
    return (
      <div className="flex h-28 w-44 items-center justify-center rounded-[14px] bg-hover px-3 text-center text-[12px] leading-5 text-label-3">
        {error}
      </div>
    );
  }
  if (loading || !src) {
    return <div className="h-28 w-44 animate-pulse rounded-[14px] bg-hover" />;
  }

  const thumbnail = (
    <img
      src={src}
      alt={name}
      className="max-h-64 max-w-full rounded-[14px] object-contain"
    />
  );

  return onOpenImage ? (
    <button
      type="button"
      className="cursor-zoom-in rounded-[14px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={`在右侧栏打开图片：${name}`}
      title={`打开图片：${name}`}
      onClick={() => onOpenImage(image)}
    >
      {thumbnail}
    </button>
  ) : (
    <a href={src} target="_blank" rel="noreferrer" className="cursor-zoom-in" title={name}>
      {thumbnail}
    </a>
  );
}

function AssistantMessage({
  message,
  streaming = false,
  showMeta = true,
  showReasoning = true,
}: {
  message: ChatMessage;
  streaming?: boolean;
  showMeta?: boolean;
  showReasoning?: boolean;
}) {
  const { threadId, shareToken } = useContext(MessageContext);
  const images = message.attachments?.filter((attachment) => attachment.kind === "image") ?? [];
  return (
    <article
      className="assistant-message group/assistant flex min-w-0 flex-col gap-4"
      aria-live={streaming ? "polite" : undefined}
    >
      {showReasoning && message.reasoning && (
        <ReasoningBlock text={message.reasoning} streaming={streaming} />
      )}
      {message.text && <Markdown>{message.text}</Markdown>}
      {images.length > 0 && threadId && (
        <div className={cn("grid max-w-2xl gap-2", images.length > 1 && "grid-cols-2")}>
          {images.map((image) => (
            <MessageImage key={image.id} id={image.id} name={image.displayName} threadId={threadId} shareToken={shareToken} />
          ))}
        </div>
      )}
      {showMeta && !streaming && (message.text || images.length > 0) && (
        <div className="-ml-1.5 flex h-7 items-center gap-2 text-label-3 opacity-100 transition-opacity duration-150 sm:opacity-0 sm:group-hover/assistant:opacity-100 sm:group-focus-within/assistant:opacity-100">
          {message.text && <CopyAction text={message.text} label="复制回复" />}
          <span className="text-[13px] leading-6 tabular-nums">
            <MessageTime at={message.createdAt} />
          </span>
        </div>
      )}
    </article>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  const { threadId, shareToken, showAuthors } = useContext(MessageContext);
  const currentUsername = useApp((state) => state.user?.username);
  const skillMatch = message.text.match(
    /^Use these skills for this request: ([^\n]+)\.\n\n([\s\S]*)$/,
  );
  const skills = skillMatch?.[1]?.split(", ").filter(Boolean) ?? [];
  const content = skillMatch?.[2] ?? message.text;
  const images = message.attachments?.filter((attachment) => attachment.kind === "image") ?? [];

  return (
    <article className="group/user flex flex-col items-end gap-1.5">
      {message.authorId && showAuthors && (
        <div className="mb-1 px-2 text-[11px] text-muted-foreground">
          {message.authorId === currentUsername ? "你" : message.authorId}
        </div>
      )}
      <div className="flex min-w-0 max-w-[min(82%,525px)] flex-col items-end gap-2">
        {images.length > 0 && (
          <div className={cn("grid gap-2", images.length > 1 && "grid-cols-2")}>
            {images.map((image) => (
              threadId ? (
                <MessageImage
                  key={image.id}
                  id={image.id}
                  name={image.displayName}
                  threadId={threadId}
                  shareToken={shareToken}
                />
              ) : null
            ))}
          </div>
        )}
        {(content || skills.length > 0) && (
          <div className="chat-bubble max-w-full rounded-[20px] bg-bubble px-4 py-[10px] text-[14px] leading-[22px] text-label-1">
            {skills.length > 0 && (
              <div className="flex flex-wrap gap-1.5 text-[12px] leading-5 text-label-3">
                {skills.map((skill) => (
                  <span key={skill} className="inline-flex items-center gap-1">
                    <Sparkles className="h-3 w-3" />/{skill}
                  </span>
                ))}
              </div>
            )}
            {content && (
              <div className={cn(skills.length > 0 && "mt-1")}>
                <Markdown>{content}</Markdown>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="flex h-7 items-center gap-2 text-label-3 opacity-100 transition-opacity duration-150 md:opacity-0 md:group-hover/user:opacity-100 md:group-focus-within/user:opacity-100">
        <span className="text-[13px] leading-6 tabular-nums">
          <MessageTime at={message.createdAt} />
        </span>
        <CopyAction text={message.text} label="复制消息" />
      </div>
    </article>
  );
}

function toolActivitiesOf(entries: readonly ChatTimelineEntry[]): ToolActivity[] {
  return entries
    .filter((entry): entry is Extract<ChatTimelineEntry, { kind: "tool" }> => entry.kind === "tool")
    .map((entry) => entry.activity);
}

function ProcessEntries({
  entries,
  onOpenSubagent,
}: {
  entries: readonly ChatTimelineEntry[];
  onOpenSubagent: (subagentId: string) => void;
}) {
  const rows: ReactNode[] = [];

  for (const entry of entries) {
    if (entry.kind === "subagent") {
      rows.push(
        <SubagentTaskCard
          key={entry.id}
          subagent={entry.subagent}
          onOpen={onOpenSubagent}
        />,
      );
      continue;
    }

    if (entry.kind === "tool") {
      rows.push(<ToolCallRow key={entry.id} activity={entry.activity} />);
      continue;
    }

    if (entry.message.role === "user") {
      rows.push(<UserMessage key={entry.id} message={entry.message} />);
    } else if (entry.message.role === "assistant") {
      rows.push(
        <AssistantMessage key={entry.id} message={entry.message} streaming={entry.message.streaming} showMeta={false} />,
      );
    }
  }

  return <div className="flex min-w-0 flex-col gap-2">{rows}</div>;
}

/** 回合过程行的标题:24px 行高,[图标] 标题 [点] 摘要。 */
function ProcessGroupHeader({
  open,
  running,
  iconKind,
  label,
  detail,
  bodyId,
  onToggle,
}: {
  open: boolean;
  running: boolean;
  iconKind: ToolKind | undefined;
  label: string;
  detail: string;
  bodyId?: string;
  onToggle?: () => void;
}) {
  const content = (
    <>
      <span className="relative flex size-4 shrink-0 items-center justify-center text-label-3">
        <span className={cn("transition-opacity duration-100", onToggle && (
          open ? "opacity-0" : "group-hover/process:opacity-0 group-focus-visible/process:opacity-0"
        ))}>
          {iconKind === undefined
            ? <Brain className="size-3.5" strokeWidth={1.8} />
            : <ToolKindIcon kind={iconKind} />}
        </span>
        {onToggle && (
          <ChevronDown
            className={cn(
              "absolute size-3.5 transition-all duration-100",
              open ? "rotate-180 opacity-100" : "opacity-0 group-hover/process:opacity-100 group-focus-visible/process:opacity-100",
            )}
          />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 truncate text-[13px] leading-6 text-label-2 transition-colors",
          running && "text-shimmer",
          onToggle && "group-hover/process:text-label-1",
        )}
      >
        {label}
      </span>
      {detail && (
        <>
          <span aria-hidden="true" className="mx-2 size-0.5 shrink-0 rounded-full bg-label-caption" />
          <span className="min-w-0 flex-1 truncate text-[13px] leading-6 text-label-3">{detail}</span>
        </>
      )}
    </>
  );
  const className = "group/process flex h-6 w-full min-w-0 select-none items-center gap-1.5 text-left";
  return onToggle ? (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={bodyId}
      onClick={onToggle}
      className={cn(className, "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60")}
    >
      {content}
    </button>
  ) : (
    <div className={className} aria-live="polite">{content}</div>
  );
}

function WorkingIndicator({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <div
      className="flex h-6 items-center text-[13px] leading-6 tabular-nums text-label-3"
      aria-live="polite"
    >
      <span className="text-shimmer text-label-2">
        {startedAt ? `已工作 ${formatDuration(now - startedAt)}` : "正在工作"}
      </span>
    </div>
  );
}

/** A process stays in place while its live title and disclosure change. */
function ToolProcessGroup({
  entries, closed, onOpenSubagent,
}: {
  entries: readonly ChatTimelineEntry[];
  closed: boolean;
  onOpenSubagent: (subagentId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const bodyId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const followBottomRef = useRef(true);
  const activities = toolActivitiesOf(entries);
  const kinds = toolCategoryKinds(activities);
  const runningActivity = [...activities].reverse().find((activity) => activity.status === "running");
  const runningAgent = [...entries].reverse().find((entry) => entry.kind === "subagent" && entry.subagent.status === "running");
  const label = closed
    ? processToolTitle(kinds, entries.some((entry) => entry.kind === "subagent"))
    : runningActivity ? liveToolLabel(runningActivity)
      : runningAgent ? "正在协调子代理" : "正在思考";
  const iconKind = closed ? kinds[0] : runningActivity ? toolCategoryKinds([runningActivity])[0] : "reasoning";
  const updateEdges = () => {
    const body = bodyRef.current;
    if (!body) return;
    setEdges({ top: body.scrollTop > 1, bottom: body.scrollHeight - body.scrollTop - body.clientHeight > 1 });
  };
  useEffect(() => {
    if (!open) return;
    const observer = new ResizeObserver(() => {
      const body = bodyRef.current;
      if (!closed && followBottomRef.current && body) body.scrollTop = body.scrollHeight;
      updateEdges();
    });
    if (bodyRef.current) observer.observe(bodyRef.current);
    if (contentRef.current) observer.observe(contentRef.current);
    updateEdges();
    return () => observer.disconnect();
  }, [open, closed]);
  const toggle = () => {
    if (!open) {
      followBottomRef.current = !closed;
      window.requestAnimationFrame(() => {
        const body = bodyRef.current;
        if (body) body.scrollTop = closed ? 0 : body.scrollHeight;
        updateEdges();
      });
    }
    setOpen((value) => !value);
  };
  return (
    <div className="min-w-0" data-tool-process data-process-closed={closed}>
      <ProcessGroupHeader open={open} running={!closed} iconKind={iconKind} label={label}
        detail="" bodyId={bodyId} onToggle={toggle} />
      <div id={bodyId} ref={bodyRef} hidden={!open} onScroll={() => {
        const body = bodyRef.current;
        if (body) followBottomRef.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
        updateEdges();
      }}
        className={cn("tool-process-body mt-4 max-h-[min(400px,50vh)] overflow-y-auto [scrollbar-gutter:stable]",
          !open && "hidden", edges.top && "tool-process-fade-top", edges.bottom && "tool-process-fade-bottom")}>
        <div ref={contentRef}>
          <ProcessEntries entries={entries} onOpenSubagent={onOpenSubagent} />
        </div>
      </div>
    </div>
  );
}

function ChatTurn({
  turnId, entries, expanded, onToggleTurn, onOpenSubagent, running, live, startedAt,
}: {
  turnId: string;
  entries: readonly ChatTimelineEntry[];
  expanded: boolean;
  onToggleTurn: (turnId: string) => void;
  onOpenSubagent: (subagentId: string) => void;
  running: boolean;
  live: { text: string; reasoning: string };
  startedAt: number | null;
}) {
  const hasLive = running && Boolean(live.text || live.reasoning);
  const contentEntries: readonly ChatTimelineEntry[] = hasLive ? [...entries, {
    kind: "message", id: "live-assistant-message", at: Date.now(),
    message: { id: "live-assistant-message", role: "assistant", text: live.text, reasoning: live.reasoning,
      streaming: true, turnId, createdAt: Date.now() },
  }] : entries;
  const content = deriveTurnContent(contentEntries, running);
  const finalReply = [...content].reverse().find((block) => block.kind === "message" && block.message.role === "assistant");
  const hasProcess = content.some((block) => block.kind === "process")
    || content.some((block) => block.kind === "message" && block.message.role === "assistant" && block.id !== finalReply?.id);
  const firstUser = content[0]?.kind === "message" && content[0].message.role === "user" ? content[0] : null;
  const start = startedAt ?? turnStartedAt(entries);
  const end = turnEndedAt(entries);
  const duration = start !== null && end !== null ? `，用时 ${formatDuration(end - start)}` : "";
  const bodyId = useId();

  return (
    <section className="flex min-w-0 flex-col gap-4" data-turn-id={turnId}>
      {firstUser && <UserMessage message={firstUser.message} />}
      {!running && hasProcess && (
        <button type="button" aria-expanded={expanded} aria-controls={bodyId}
          onClick={() => onToggleTurn(turnId)}
          className="flex min-h-6 w-fit items-center gap-1.5 text-left text-[13px] leading-6 text-label-2 transition-colors hover:text-label-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
          <span>{`已完成${duration}`}</span>
          {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
        </button>
      )}
      <div id={bodyId} className="flex min-w-0 flex-col gap-4">
        {content.filter((block) => block !== firstUser).map((block) => {
          const independent = block.kind === "message" && block.message.role === "user";
          const hidden = !running && hasProcess && !expanded && block.id !== finalReply?.id && !independent;
          return (
            <div key={block.id} hidden={hidden} className={cn("min-w-0", hidden && "hidden")}>
              {block.kind === "process" ? (
                <ToolProcessGroup entries={block.entries} closed={block.closed} onOpenSubagent={onOpenSubagent} />
              ) : block.message.role === "user" ? (
                <UserMessage message={block.message} />
              ) : (
                <AssistantMessage message={block.message} streaming={block.message.streaming}
                  showReasoning={false} showMeta={!running && block.id === finalReply?.id} />
              )}
            </div>
          );
        })}
        {running && <WorkingIndicator startedAt={start} />}
      </div>
    </section>
  );
}

function subagentTimelineEntries(
  subagent: SubagentActivity,
  allSubagents: readonly SubagentActivity[],
): ChatTimelineEntry[] {
  const children = allSubagents.filter((candidate) => candidate.parentAgentId === subagent.id);
  const delegatedToolCallIds = new Set(children.map((child) => child.toolCallId));
  return [
    ...subagent.messages.map((message) => ({
      kind: "message" as const,
      id: `subagent-message:${subagent.id}:${message.id}`,
      at: message.createdAt,
      message: {
        ...message,
        role: message.role,
        turnId: subagent.turnId,
      },
    })),
    ...subagent.activities
      .filter((activity) => !delegatedToolCallIds.has(activity.id))
      .map((activity) => ({
        kind: "tool" as const,
        id: `subagent-tool:${subagent.id}:${activity.id}`,
        at: activity.startedAt,
        activity,
      })),
    ...children.map((child) => ({
      kind: "subagent" as const,
      id: `subagent:${child.id}`,
      at: child.startedAt,
      subagent: child,
    })),
  ].sort((left, right) => left.at - right.at || left.id.localeCompare(right.id));
}

function SubagentDetail({
  subagent,
  allSubagents,
  onOpenSubagent,
  onBack,
}: {
  subagent: SubagentActivity;
  allSubagents: readonly SubagentActivity[];
  onOpenSubagent: (subagentId: string) => void;
  onBack: () => void;
}) {
  const entries = subagentTimelineEntries(subagent, allSubagents);
  const parent = subagent.parentAgentId
    ? allSubagents.find((candidate) => candidate.id === subagent.parentAgentId)
    : undefined;
  const duration = subagent.durationMs ?? (
    subagent.endedAt ? subagent.endedAt - subagent.startedAt : undefined
  );
  const details = [
    subagent.model,
    duration !== undefined ? formatDuration(duration) : undefined,
    subagent.totalToolCalls !== undefined
      ? `${subagent.totalToolCalls} 次工具调用`
      : subagent.activities.length > 0
        ? `${subagent.activities.length} 次工具调用`
        : undefined,
  ].filter(Boolean);
  const hasLive = Boolean(subagent.live?.text || subagent.live?.reasoning);
  const taskTitle = subagentTaskTitle(subagent);
  const hasPromptMessage = subagent.messages.some(
    (message) => message.role === "user" && message.text === subagent.prompt,
  );

  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-10 -mx-4 mb-5 border-b border-line-2 bg-background/95 px-4 pb-3 pt-1 backdrop-blur">
        <div className="flex min-w-0 items-center gap-1.5 text-[13px] text-label-3">
          <button
            type="button"
            className="flex h-7 shrink-0 items-center gap-1 rounded-[8px] px-1.5 transition-colors hover:bg-hover hover:text-label-1"
            onClick={onBack}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>{parent ? parent.agentDisplayName : "主会话"}</span>
          </button>
          <ChevronRight className="h-3 w-3 shrink-0 text-label-caption" />
          <span className="min-w-0 truncate">{taskTitle}</span>
        </div>
      </header>

      <section className="mb-5 border-b border-line-2 pb-5">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-hover text-label-2">
            <Bot className="h-4 w-4" strokeWidth={1.8} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] text-label-3">
              {subagent.agentDisplayName || "子代理"}
            </div>
            <h2 className="mt-0.5 break-words text-[16px] font-semibold leading-6 text-label-1">
              {taskTitle}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-label-3">
              <span className="inline-flex items-center gap-1">
                {subagent.status === "running" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : subagent.status === "idle" ? (
                  <Pause className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                ) : subagent.status === "cancelled" ? (
                  <Ban className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                ) : subagent.status === "error" ? (
                  <X className="h-3 w-3 text-red-500" />
                ) : (
                  <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                )}
                {subagentStatusText(subagent)}
              </span>
              {details.map((detail) => <span key={detail}>· {detail}</span>)}
            </div>
          </div>
        </div>
        {subagent.prompt && subagent.prompt !== taskTitle && !hasPromptMessage && (
          <div className="mt-4 border-l-2 border-line-2 pl-3.5 text-[13px] leading-5 text-label-2">
            <Markdown>{subagent.prompt}</Markdown>
          </div>
        )}
      </section>

      <div className="flex flex-col gap-4">
        <ProcessEntries
          entries={entries}
          onOpenSubagent={onOpenSubagent}
        />
        {hasLive && subagent.live && (
          <AssistantMessage
            streaming
            showMeta={false}
            message={{
              id: `live-subagent-${subagent.id}`,
              role: "assistant",
              text: subagent.live.text,
              reasoning: subagent.live.reasoning,
              streaming: true,
              turnId: subagent.turnId,
              createdAt: subagent.live.startedAt,
            }}
          />
        )}
        {subagent.status === "running" && !hasLive && (
          <WorkingIndicator startedAt={subagent.startedAt} />
        )}
        {subagent.status === "idle" && !hasLive && (
          <div className="flex items-center gap-2 text-[13px] leading-6 text-label-3">
            <Pause className="h-3.5 w-3.5" />
            等待后续任务
          </div>
        )}
        {subagent.error && (
          <div
            role="alert"
            className={cn(
              "flex items-start gap-2 text-[13px] leading-5",
              subagent.status === "cancelled" ? "text-amber-600 dark:text-amber-400" : "text-destructive",
            )}
          >
            {subagent.status === "cancelled" ? <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            <span>{subagent.error}</span>
          </div>
        )}
        {subagent.status !== "running" && subagent.status !== "idle" && !subagent.error && entries.length === 0 && !hasLive && (
          <div className="py-8 text-center text-[13px] text-label-caption">子代理没有返回可展示的内容</div>
        )}
      </div>
    </div>
  );
}

export function ChatView({
  threadId,
  bottomInset = 0,
  shareToken,
  manageSubscription = true,
  showAuthors,
  selectedSubagentId: controlledSubagentId,
  onSubagentViewChange,
  onOpenImage,
}: {
  threadId: string;
  bottomInset?: number;
  shareToken?: string;
  manageSubscription?: boolean;
  showAuthors?: boolean;
  selectedSubagentId?: string | null;
  onSubagentViewChange?: (subagentId: string | null) => void;
  onOpenImage?: (image: ImagePreviewTarget) => void;
}) {
  const state = useThreadState(threadId);
  const openThread = useApp((appState) => appState.openThread);
  const closeThread = useApp((appState) => appState.closeThread);
  const thread = useApp((appState) =>
    appState.threads.find((candidate) => candidate.id === threadId),
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [internalSubagentId, setInternalSubagentId] = useState<string | null>(null);
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!manageSubscription) return;
    let active = true;
    pinnedRef.current = true;
    setAtBottom(true);
    setLoadError("");
    setInternalSubagentId(null);
    onSubagentViewChange?.(null);
    setExpandedTurnIds(new Set());
    void openThread(threadId).catch((error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : "无法加载会话");
    });
    return () => {
      active = false;
      void closeThread(threadId);
    };
  }, [threadId, openThread, closeThread, manageSubscription, onSubagentViewChange]);

  useEffect(() => {
    if (state.loaded) setLoadError("");
  }, [state.loaded]);

  const blocks = useMemo(
    () => deriveChatTimeline(state.messages, state.activities, state.subagents),
    [state.messages, state.activities, state.subagents],
  );
  const selectedSubagentId = controlledSubagentId === undefined
    ? internalSubagentId
    : controlledSubagentId;
  const selectedSubagent = selectedSubagentId
    ? state.subagents.find((subagent) => subagent.id === selectedSubagentId)
    : undefined;

  useEffect(() => {
    if (!selectedSubagentId || !state.loaded || selectedSubagent) return;
    setInternalSubagentId(null);
    onSubagentViewChange?.(null);
  }, [onSubagentViewChange, selectedSubagent, selectedSubagentId, state.loaded]);
  const activeTurnId = state.activeTurnId ?? state.live.turnId;
  const hasLive = Boolean(state.live.text || state.live.reasoning);
  const hasActiveTurnBlock = blocks.some(
    (block) => block.kind === "turn" && state.running && block.turnId === activeTurnId,
  );

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !pinnedRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
      setAtBottom(true);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [blocks, state.live.text, state.live.reasoning, state.running, bottomInset]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const nextAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
    pinnedRef.current = nextAtBottom;
    setAtBottom(nextAtBottom);
  };

  const scrollToBottom = () => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedRef.current = true;
    setAtBottom(true);
    element.scrollTo({ top: element.scrollHeight, behavior: "smooth" });
  };

  const toggleTurn = (turnId: string) => {
    setExpandedTurnIds((existing) => {
      const next = new Set(existing);
      if (next.has(turnId)) next.delete(turnId);
      else next.add(turnId);
      return next;
    });
  };

  const openSubagent = (subagentId: string) => {
    if (controlledSubagentId === undefined) setInternalSubagentId(subagentId);
    onSubagentViewChange?.(subagentId);
    pinnedRef.current = false;
    window.requestAnimationFrame(() => {
      if (scrollRef.current) scrollRef.current.scrollTop = 0;
    });
  };

  const leaveSubagent = () => {
    if (!selectedSubagent) return;
    const previousId = selectedSubagent.id;
    const parentId = selectedSubagent.parentAgentId ?? null;
    if (controlledSubagentId === undefined) setInternalSubagentId(parentId);
    onSubagentViewChange?.(parentId);
    window.requestAnimationFrame(() => {
      const element = scrollRef.current;
      if (!element) return;
      if (parentId) {
        element.scrollTop = 0;
        return;
      }
      const task = element.querySelector<HTMLElement>(
        `[data-subagent-id="${CSS.escape(previousId)}"]`,
      );
      task?.scrollIntoView({ block: "center" });
    });
  };

  if (loadError && !state.loaded) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <div className="max-w-md text-center text-[13px] leading-5 text-destructive">{loadError}</div>
      </div>
    );
  }

  if (!state.loaded) {
    return (
      <div className="flex h-full items-center justify-center text-label-caption">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const shouldShowAuthors =
    showAuthors ??
    Boolean(thread?.shared || thread?.access === "readonly" || thread?.access === "collaborate");

  return (
    <MessageContext.Provider value={{ threadId, shareToken, showAuthors: shouldShowAuthors, onOpenImage }}>
      <div className="relative h-full">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={(event) => {
            if (event.deltaY < 0) pinnedRef.current = false;
          }}
          className="h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain [scrollbar-gutter:stable]"
        >
          <div
            className="mx-auto flex min-h-full w-full max-w-[min(100%,calc(clamp(680px,64%,920px)+32px))] flex-col gap-4 px-4 pt-4"
            style={{ paddingBottom: Math.max(24, bottomInset + 16) }}
          >
            {selectedSubagent ? (
              <SubagentDetail
                subagent={selectedSubagent}
                allSubagents={state.subagents}
                onOpenSubagent={openSubagent}
                onBack={leaveSubagent}
              />
            ) : (
              <>
                {blocks.length === 0 && !hasLive && !state.running && (
                  <div className="flex flex-1 items-center justify-center py-16 text-[13px] text-label-caption">
                    新会话
                  </div>
                )}

                {blocks.map((block) => {
                  if (block.kind === "system") {
                    return (
                      <div key={block.id} className="py-2 text-center text-[12px] leading-5 text-label-3">
                        {block.message.text}
                      </div>
                    );
                  }

                  const running = state.running && block.turnId === activeTurnId;
                  return (
                    <ChatTurn
                      key={block.id}
                      turnId={block.turnId}
                      entries={block.entries}
                      expanded={expandedTurnIds.has(block.turnId)}
                      onToggleTurn={toggleTurn}
                      onOpenSubagent={openSubagent}
                      running={running}
                      live={state.live}
                      startedAt={running ? state.activeTurnStartedAt : null}
                    />
                  );
                })}

                {state.running && !hasActiveTurnBlock && (
                  <section className="flex flex-col gap-4">
                    {hasLive && (
                      <AssistantMessage
                        streaming
                        showMeta={false}
                        message={{
                          id: "live-assistant-message",
                          role: "assistant",
                          text: state.live.text,
                          reasoning: state.live.reasoning,
                          streaming: true,
                          turnId: activeTurnId ?? "live",
                          createdAt: Date.now(),
                        }}
                      />
                    )}
                    <WorkingIndicator startedAt={state.activeTurnStartedAt} />
                  </section>
                )}

                {state.error && (
                  <div role="status" className="flex items-start gap-2 text-[13px] leading-5">
                    <span aria-hidden="true" className="mt-[5px] size-2.5 shrink-0 rounded-full bg-destructive" />
                    <div className="min-w-0 [overflow-wrap:anywhere]">
                      <span className="mr-1.5 font-semibold text-destructive">出错了</span>
                      <span className="text-label-2">{state.error}</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {!selectedSubagent && !atBottom && (
          <button
            type="button"
            aria-label="回到最新消息"
            title="回到最新消息"
            className="absolute right-[max(16px,calc((100%-clamp(680px,64%,920px))/2))] z-10 flex size-[34px] items-center justify-center rounded-full border border-line-3 bg-elevated text-label-1 shadow-[0_4px_16px_rgb(0_0_0_/_10%)] transition-colors hover:bg-hover-solid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
            style={{ bottom: bottomInset + 16 }}
            onClick={scrollToBottom}
          >
            <ArrowDown className="h-4 w-4" />
          </button>
        )}
      </div>
    </MessageContext.Provider>
  );
}
