import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Loader2,
  Sparkles,
} from "lucide-react";
import type { ChatMessage, ToolActivity } from "@cca/protocol";
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

function CopyAction({ text, label }: { text: string; label: string }) {
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
      className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
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

function MessageImage({ id, name, threadId }: { id: string; name: string; threadId: string }) {
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    void loadImage(id, threadId, controller.signal)
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
  }, [id, threadId]);

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
  const threadId = useApp((state) => state.activeThreadId);
  const skillMatch = message.text.match(
    /^Use these skills for this request: ([^\n]+)\.\n\n([\s\S]*)$/,
  );
  const skills = skillMatch?.[1]?.split(", ").filter(Boolean) ?? [];
  const content = skillMatch?.[2] ?? message.text;
  const images = message.attachments?.filter((attachment) => attachment.kind === "image") ?? [];

  return (
    <article className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] rounded-2xl border border-zinc-200 bg-zinc-100 p-3 text-zinc-900 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-100">
        {images.length > 0 && (
          <div className={cn("grid gap-2", images.length > 1 && "grid-cols-2")}>
            {images.map((image) => (
              threadId ? <MessageImage key={image.id} id={image.id} name={image.displayName} threadId={threadId} /> : null
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
      <div className="flex h-7 w-full max-w-[80%] items-center justify-end gap-1 pr-1 text-xs text-zinc-400 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        <MessageTime at={message.createdAt} />
        {content && <CopyAction text={content} label="复制消息" />}
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
}: {
  entries: readonly ChatTimelineEntry[];
  expandedWorkGroups: ReadonlySet<string>;
  onToggleWorkGroup: (groupId: string) => void;
}) {
  const rows: ReactNode[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;

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
}: {
  turnId: string;
  entries: readonly ChatTimelineEntry[];
  expanded: boolean;
  expandedWorkGroups: ReadonlySet<string>;
  onToggleTurn: (turnId: string) => void;
  onToggleWorkGroup: (groupId: string) => void;
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
  const startedAt = turnStartedAt(entries);
  const endedAt = turnEndedAt(entries);
  const durationLabel =
    startedAt !== null && endedAt !== null ? `工作了 ${formatDuration(endedAt - startedAt)}` : "工作过程";

  return (
    <section className="flex flex-col gap-3" data-turn-id={turnId}>
      {userEntries.map((entry) => (
        <UserMessage key={entry.id} message={entry.message} />
      ))}
      {processEntries.length > 0 && (
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
          {expanded && (
            <ProcessEntries
              entries={processEntries}
              expandedWorkGroups={expandedWorkGroups}
              onToggleWorkGroup={onToggleWorkGroup}
            />
          )}
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
}: {
  entries: readonly ChatTimelineEntry[];
  live: { text: string; reasoning: string };
  startedAt: number | null;
  expandedWorkGroups: ReadonlySet<string>;
  onToggleWorkGroup: (groupId: string) => void;
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
      />
      {hasLive && <AssistantMessage message={liveMessage} streaming showMeta={false} />}
      <WorkingIndicator startedAt={startedAt ?? turnStartedAt(entries)} />
    </section>
  );
}

export function ChatView({ threadId, bottomInset = 0 }: { threadId: string; bottomInset?: number }) {
  const state = useThreadState(threadId);
  const openThread = useApp((appState) => appState.openThread);
  const closeThread = useApp((appState) => appState.closeThread);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [expandedTurnIds, setExpandedTurnIds] = useState<ReadonlySet<string>>(new Set());
  const [expandedWorkGroups, setExpandedWorkGroups] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let active = true;
    pinnedRef.current = true;
    setAtBottom(true);
    setLoadError("");
    setExpandedTurnIds(new Set());
    setExpandedWorkGroups(new Set());
    void openThread(threadId).catch((error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : "无法加载会话");
    });
    return () => {
      active = false;
      void closeThread(threadId);
    };
  }, [threadId, openThread, closeThread]);

  useEffect(() => {
    if (state.loaded) setLoadError("");
  }, [state.loaded]);

  const blocks = useMemo(
    () => deriveChatTimeline(state.messages, state.activities),
    [state.messages, state.activities],
  );
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

  return (
    <div className="relative h-full">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        onWheel={(event) => {
          if (event.deltaY < 0) pinnedRef.current = false;
        }}
        className="h-full overflow-y-auto overflow-x-hidden overscroll-y-contain"
      >
        <div
          className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4 px-3 pt-4 sm:px-5 sm:pt-5"
          style={{ paddingBottom: Math.max(20, bottomInset + 16) }}
        >
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
        </div>
      </div>

      {!atBottom && (
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
  );
}
