import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowLeft,
  Ban,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  Pause,
  Sparkles,
  X,
} from "lucide-react";
import type { ChatMessage, SubagentActivity, ToolActivity } from "@cca/protocol";
import { loadImage } from "../lib/client";
import { useApp, useThreadState } from "../lib/store";
import {
  deriveChatTimeline,
  findTerminalAssistantEntry,
  turnEndedAt,
  turnStartedAt,
  type ChatTimelineEntry,
} from "../lib/chatTimeline";
import { Markdown } from "./Markdown";
import { ToolCallRow } from "./ToolCallRow";
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

function ReasoningBlock({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(streaming);

  useEffect(() => {
    setOpen(streaming);
  }, [streaming]);

  return (
    <div className="mb-2 overflow-hidden rounded-md border border-zinc-200/80 bg-zinc-50/60 text-xs dark:border-zinc-800 dark:bg-zinc-900/50">
      <button
        type="button"
        aria-expanded={open}
        className="flex min-h-8 w-full items-center gap-1.5 px-2.5 py-1.5 text-left font-medium text-zinc-500 hover:bg-zinc-100/70 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800/60 dark:hover:text-zinc-200"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 shrink-0 transition-transform", open && "rotate-90")}
        />
        <Bot className="h-3.5 w-3.5 shrink-0" />
        <span>{streaming ? "正在思考" : "思考过程"}</span>
        {streaming && <span className="animate-pulse text-zinc-400">...</span>}
      </button>
      {open && (
        <div className="mx-2.5 mb-2.5 border-l-2 border-zinc-200 pl-2.5 text-sm leading-6 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
          <Markdown>{text}</Markdown>
        </div>
      )}
    </div>
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
    <button
      type="button"
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-200",
        className,
      )}
      aria-label={copied ? "已复制" : label}
      title={copied ? "已复制" : label}
      onClick={() => void copy()}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
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
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    void loadImage(id, threadId, controller.signal, shareToken)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, shareToken, threadId]);

  if (failed) {
    return (
      <div className="flex h-28 w-44 items-center justify-center rounded-xl bg-zinc-200 px-3 text-center text-xs text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400">
        图片加载失败
      </div>
    );
  }
  if (!src) {
    return <div className="h-28 w-44 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-700" />;
  }
  return (
    <a href={src} target="_blank" rel="noreferrer" title={name}>
      <img
        src={src}
        alt={name}
        className="max-h-64 max-w-full rounded-xl object-contain"
      />
    </a>
  );
}

function AssistantMessage({
  message,
  streaming = false,
  showMeta = true,
}: {
  message: ChatMessage;
  streaming?: boolean;
  showMeta?: boolean;
}) {
  return (
    <article
      className="group/assistant min-w-0 px-1 py-0.5"
      aria-live={streaming ? "polite" : undefined}
    >
      {message.reasoning && <ReasoningBlock text={message.reasoning} streaming={streaming} />}
      {message.text && <Markdown>{message.text}</Markdown>}
      {showMeta && !streaming && message.text && (
        <div className="mt-1.5 flex h-7 items-center gap-2 text-xs text-zinc-400 opacity-100 transition-opacity sm:opacity-0 sm:group-hover/assistant:opacity-100 sm:group-focus-within/assistant:opacity-100">
          <CopyAction text={message.text} label="复制回复" />
          <MessageTime at={message.createdAt} />
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
    <article className="group/user flex flex-col items-end py-1">
      {message.authorId && showAuthors && (
        <div className="mb-1 px-2 text-[11px] text-muted-foreground">
          {message.authorId === currentUsername ? "你" : message.authorId}
        </div>
      )}
      <div className="relative max-w-[80%] rounded-xl bg-card px-3 py-2 text-card-foreground">
        <CopyAction
          text={message.text}
          label="复制消息"
          className="absolute -left-9 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover/user:opacity-100 group-focus-within/user:opacity-100"
        />
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
        {skills.length > 0 && (
          <div className={cn("flex flex-wrap gap-1.5 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400", images.length > 0 && "mt-2")}>
            {skills.map((skill) => (
              <span key={skill} className="inline-flex items-center gap-1">
                <Sparkles className="h-3 w-3" />/{skill}
              </span>
            ))}
          </div>
        )}
        {content && (
          <div className={cn((images.length > 0 || skills.length > 0) && "mt-1.5")}>
            <Markdown>{content}</Markdown>
          </div>
        )}
      </div>
    </article>
  );
}

function WorkGroup({
  activities,
  groupId,
  expanded,
  onToggle,
}: {
  activities: ToolActivity[];
  groupId: string;
  expanded: boolean;
  onToggle: (groupId: string) => void;
}) {
  const hiddenCount = Math.max(0, activities.length - 1);
  const visibleActivities = expanded ? activities : activities.slice(-1);

  return (
    <div className="space-y-px py-0.5">
      {visibleActivities.map((activity) => (
        <ToolCallRow key={activity.id} activity={activity} />
      ))}
      {hiddenCount > 0 && (
        <button
          type="button"
          aria-expanded={expanded}
          className="flex w-full items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-xs font-medium leading-5 text-zinc-600 hover:bg-zinc-100/60 hover:text-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-900/60 dark:hover:text-zinc-100"
          onClick={() => onToggle(groupId)}
        >
          <span className="flex h-5 w-5 shrink-0 items-center justify-center text-zinc-400">
            <ChevronDown
              className={cn(
                "h-3.5 w-3.5 transition-transform duration-200",
                expanded && "rotate-180",
              )}
            />
          </span>
          {expanded ? "收起工具调用" : `先前的 ${hiddenCount} 次工具调用`}
        </button>
      )}
    </div>
  );
}

function ProcessEntries({
  entries,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenSubagent,
}: {
  entries: readonly ChatTimelineEntry[];
  expandedWorkGroups: ReadonlySet<string>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenSubagent: (subagentId: string) => void;
}) {
  const rows: ReactNode[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;

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
      const activities = [entry.activity];
      let cursor = index + 1;
      while (entries[cursor]?.kind === "tool") {
        activities.push((entries[cursor] as Extract<ChatTimelineEntry, { kind: "tool" }>).activity);
        cursor += 1;
      }
      const groupId = `work-group:${entry.id}`;
      rows.push(
        <WorkGroup
          key={groupId}
          activities={activities}
          groupId={groupId}
          expanded={expandedWorkGroups.has(groupId)}
          onToggle={onToggleWorkGroup}
        />,
      );
      index = cursor - 1;
      continue;
    }

    if (entry.message.role === "user") {
      rows.push(<UserMessage key={entry.id} message={entry.message} />);
    } else if (entry.message.role === "assistant") {
      rows.push(
        <AssistantMessage key={entry.id} message={entry.message} showMeta={false} />,
      );
    }
  }

  return <>{rows}</>;
}

function WorkingIndicator({ startedAt }: { startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  return (
    <div className="flex items-center gap-2 px-1.5 py-1 text-[11px] tabular-nums text-zinc-400" aria-live="polite">
      <span className="inline-flex items-center gap-[3px]" aria-hidden="true">
        <span className="h-1 w-1 animate-pulse rounded-full bg-zinc-400/60" />
        <span className="h-1 w-1 animate-pulse rounded-full bg-zinc-400/60 [animation-delay:200ms]" />
        <span className="h-1 w-1 animate-pulse rounded-full bg-zinc-400/60 [animation-delay:400ms]" />
      </span>
      <span>{startedAt ? `已工作 ${formatDuration(now - startedAt)}` : "正在工作"}</span>
    </div>
  );
}

function CompletedTurn({
  turnId,
  entries,
  expanded,
  expandedWorkGroups,
  onToggleTurn,
  onToggleWorkGroup,
  onOpenSubagent,
}: {
  turnId: string;
  entries: readonly ChatTimelineEntry[];
  expanded: boolean;
  expandedWorkGroups: ReadonlySet<string>;
  onToggleTurn: (turnId: string) => void;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenSubagent: (subagentId: string) => void;
}) {
  const terminalAssistant = findTerminalAssistantEntry(entries);
  const userEntries = entries.filter(
    (entry): entry is Extract<ChatTimelineEntry, { kind: "message" }> =>
      entry.kind === "message" && entry.message.role === "user",
  );
  const processEntries = entries.filter(
    (entry) =>
      !(entry.kind === "message" && entry.message.role === "user") &&
      entry.id !== terminalAssistant?.id,
  );
  const processSegments: ChatTimelineEntry[][] = [];
  for (const entry of processEntries) {
    if (entry.kind === "subagent") {
      processSegments.push([entry]);
      continue;
    }
    const current = processSegments.at(-1);
    if (current && current[0]?.kind !== "subagent") current.push(entry);
    else processSegments.push([entry]);
  }
  const hasCollapsibleEntries = processEntries.some((entry) => entry.kind !== "subagent");
  const startedAt = turnStartedAt(entries);
  const endedAt = turnEndedAt(entries);
  const durationLabel =
    startedAt !== null && endedAt !== null ? `工作了 ${formatDuration(endedAt - startedAt)}` : "工作过程";

  return (
    <section className="flex flex-col gap-3" data-turn-id={turnId}>
      {userEntries.map((entry) => (
        <UserMessage key={entry.id} message={entry.message} />
      ))}
      {processSegments.map((segment) => {
        const first = segment[0];
        if (!first) return null;
        if (first.kind === "subagent") {
          return (
            <SubagentTaskCard
              key={first.id}
              subagent={first.subagent}
              onOpen={onOpenSubagent}
            />
          );
        }
        if (!expanded) return null;
        return (
          <ProcessEntries
            key={`segment:${first.id}`}
            entries={segment}
            expandedWorkGroups={expandedWorkGroups}
            onToggleWorkGroup={onToggleWorkGroup}
            onOpenSubagent={onOpenSubagent}
          />
        );
      })}
      {hasCollapsibleEntries && (
        <>
          <div className="border-b border-zinc-200/80 pb-2 pt-0.5 dark:border-zinc-800">
            <button
              type="button"
              aria-expanded={expanded}
              className="flex items-center gap-1 rounded-md px-1 text-xs tabular-nums text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
              onClick={() => onToggleTurn(turnId)}
            >
              <span>{durationLabel}</span>
              {expanded ? (
                <ChevronDown className="h-3.5 w-3.5" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </>
      )}
      {terminalAssistant && <AssistantMessage message={terminalAssistant.message} />}
    </section>
  );
}

function RunningTurn({
  entries,
  live,
  startedAt,
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenSubagent,
}: {
  entries: readonly ChatTimelineEntry[];
  live: { text: string; reasoning: string };
  startedAt: number | null;
  expandedWorkGroups: ReadonlySet<string>;
  onToggleWorkGroup: (groupId: string) => void;
  onOpenSubagent: (subagentId: string) => void;
}) {
  const hasLive = Boolean(live.text || live.reasoning);
  const liveMessage: ChatMessage = {
    id: "live-assistant-message",
    role: "assistant",
    text: live.text,
    reasoning: live.reasoning,
    streaming: true,
    turnId: "live",
    createdAt: Date.now(),
  };

  return (
    <section className="flex flex-col gap-3">
      <ProcessEntries
        entries={entries}
        expandedWorkGroups={expandedWorkGroups}
        onToggleWorkGroup={onToggleWorkGroup}
        onOpenSubagent={onOpenSubagent}
      />
      {hasLive && <AssistantMessage message={liveMessage} streaming showMeta={false} />}
      <WorkingIndicator startedAt={startedAt ?? turnStartedAt(entries)} />
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
  expandedWorkGroups,
  onToggleWorkGroup,
  onOpenSubagent,
  onBack,
}: {
  subagent: SubagentActivity;
  allSubagents: readonly SubagentActivity[];
  expandedWorkGroups: ReadonlySet<string>;
  onToggleWorkGroup: (groupId: string) => void;
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
      <header className="sticky top-0 z-10 -mx-3 mb-5 border-b border-zinc-200 bg-white/95 px-3 pb-3 pt-1 backdrop-blur sm:-mx-5 sm:px-5 dark:border-border dark:bg-background/95">
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-500 dark:text-zinc-400">
          <button
            type="button"
            className="flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
            onClick={onBack}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>{parent ? parent.agentDisplayName : "主会话"}</span>
          </button>
          <ChevronRight className="h-3 w-3 shrink-0 text-zinc-300 dark:text-zinc-700" />
          <span className="min-w-0 truncate">{taskTitle}</span>
        </div>
      </header>

      <section className="mb-5 border-b border-zinc-200 pb-5 dark:border-zinc-800">
        <div className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-300">
            <Bot className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
              {subagent.agentDisplayName || "子代理"}
            </div>
            <h2 className="mt-0.5 break-words text-base font-semibold text-zinc-900 dark:text-zinc-100">
              {taskTitle}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-400">
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
          <div className="mt-4 border-l-2 border-zinc-200 pl-3 text-sm leading-6 text-zinc-600 dark:border-zinc-800 dark:text-zinc-300">
            <Markdown>{subagent.prompt}</Markdown>
          </div>
        )}
      </section>

      <div className="flex flex-col gap-3">
        <ProcessEntries
          entries={entries}
          expandedWorkGroups={expandedWorkGroups}
          onToggleWorkGroup={onToggleWorkGroup}
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
          <div className="flex items-center gap-2 px-1.5 py-2 text-xs text-zinc-400">
            <Pause className="h-3.5 w-3.5" />
            等待后续任务
          </div>
        )}
        {subagent.error && (
          <div className={cn(
            "rounded-md border px-3 py-2.5 text-sm",
            subagent.status === "cancelled"
              ? "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-950 dark:bg-amber-950/30 dark:text-amber-300"
              : "border-red-200 bg-red-50 text-red-700 dark:border-red-950 dark:bg-red-950/30 dark:text-red-300",
          )}>
            {subagent.error}
          </div>
        )}
        {subagent.status !== "running" && subagent.status !== "idle" && !subagent.error && entries.length === 0 && !hasLive && (
          <div className="py-8 text-center text-sm text-zinc-400">子代理没有返回可展示的内容</div>
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
}: {
  threadId: string;
  bottomInset?: number;
  shareToken?: string;
  manageSubscription?: boolean;
  showAuthors?: boolean;
  selectedSubagentId?: string | null;
  onSubagentViewChange?: (subagentId: string | null) => void;
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
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    if (!manageSubscription) return;
    let active = true;
    pinnedRef.current = true;
    setAtBottom(true);
    setLoadError("");
    setInternalSubagentId(null);
    onSubagentViewChange?.(null);
    setExpandedTurnIds(new Set());
    setExpandedWorkGroups(new Set());
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

  const toggleWorkGroup = (groupId: string) => {
    setExpandedWorkGroups((existing) => {
      const next = new Set(existing);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
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
        <div className="max-w-md text-center text-sm text-red-600 dark:text-red-400">{loadError}</div>
      </div>
    );
  }

  if (!state.loaded) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const shouldShowAuthors =
    showAuthors ??
    Boolean(thread?.shared || thread?.access === "readonly" || thread?.access === "collaborate");

  return (
    <MessageContext.Provider value={{ threadId, shareToken, showAuthors: shouldShowAuthors }}>
      <div className="relative h-full">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          onWheel={(event) => {
            if (event.deltaY < 0) pinnedRef.current = false;
          }}
          className="h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-y-contain [scrollbar-gutter:stable_both-edges]"
        >
          <div
            className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4 px-3 pt-4 sm:px-5 sm:pt-5"
            style={{ paddingBottom: Math.max(20, bottomInset + 16) }}
          >
            {selectedSubagent ? (
              <SubagentDetail
                subagent={selectedSubagent}
                allSubagents={state.subagents}
                expandedWorkGroups={expandedWorkGroups}
                onToggleWorkGroup={toggleWorkGroup}
                onOpenSubagent={openSubagent}
                onBack={leaveSubagent}
              />
            ) : (
              <>
                {blocks.length === 0 && !hasLive && !state.running && (
                  <div className="flex flex-1 items-center justify-center py-16 text-sm text-zinc-300 dark:text-zinc-700">
                    新会话
                  </div>
                )}

                {blocks.map((block) => {
                  if (block.kind === "system") {
                    return (
                      <div key={block.id} className="py-2 text-center text-xs text-zinc-400">
                        {block.message.text}
                      </div>
                    );
                  }

                  const running = state.running && block.turnId === activeTurnId;
                  return running ? (
                    <RunningTurn
                      key={block.id}
                      entries={block.entries}
                      live={state.live}
                      startedAt={state.activeTurnStartedAt}
                      expandedWorkGroups={expandedWorkGroups}
                      onToggleWorkGroup={toggleWorkGroup}
                      onOpenSubagent={openSubagent}
                    />
                  ) : (
                    <CompletedTurn
                      key={block.id}
                      turnId={block.turnId}
                      entries={block.entries}
                      expanded={expandedTurnIds.has(block.turnId)}
                      expandedWorkGroups={expandedWorkGroups}
                      onToggleTurn={toggleTurn}
                      onToggleWorkGroup={toggleWorkGroup}
                      onOpenSubagent={openSubagent}
                    />
                  );
                })}

                {state.running && !hasActiveTurnBlock && (
                  <section className="flex flex-col gap-3">
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
                  <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:border-red-950 dark:bg-red-950/30 dark:text-red-300">
                    {state.error}
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
            className="absolute left-1/2 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-600 shadow-sm hover:bg-zinc-50 hover:text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            style={{ bottom: bottomInset + 6 }}
            onClick={scrollToBottom}
          >
            <ArrowDown className="h-3.5 w-3.5" />
            回到最新消息
          </button>
        )}
      </div>
    </MessageContext.Provider>
  );
}
