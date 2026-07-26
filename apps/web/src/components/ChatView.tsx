import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Copy,
  Loader2,
  Sparkles,
} from "lucide-react";
import type { ChatMessage, ToolActivity } from "@cca/protocol";
import { useApp, useThreadState } from "../lib/store";
import { Markdown } from "./Markdown";
import { ToolCallRow } from "./ToolCallRow";
import { cn } from "../lib/utils";

type TimelineEntry =
  | { type: "message"; at: number; message: ChatMessage }
  | { type: "tool"; at: number; activity: ToolActivity };

function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(Boolean(streaming));
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-200 bg-zinc-50/70 text-xs dark:border-zinc-800 dark:bg-zinc-900/60">
      <button
        type="button"
        aria-expanded={open}
        className="flex min-h-9 w-full items-center gap-2 px-3 py-2 text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")}
        />
        <Brain className="h-3.5 w-3.5" />
        <span>{streaming ? "正在思考" : "思考过程"}</span>
        {streaming && <span className="ml-auto h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />}
      </button>
      {open && (
        <div className="max-h-64 overflow-y-auto border-t border-zinc-200 px-3 py-2.5 leading-5 whitespace-pre-wrap text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          {text}
        </div>
      )}
    </div>
  );
}

function CopyAction({ text }: { text: string }) {
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
      className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 opacity-100 hover:bg-zinc-100 hover:text-zinc-700 sm:opacity-0 sm:group-hover:opacity-100 dark:hover:bg-zinc-900 dark:hover:text-zinc-200"
      aria-label={copied ? "已复制" : "复制回复"}
      title={copied ? "已复制" : "复制回复"}
      onClick={() => void copy()}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

function AssistantMessage({ message }: { message: ChatMessage }) {
  return (
    <article className="group flex gap-3 py-1">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
        <Bot className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">编码助手</div>
        <div className="space-y-2">
          {message.reasoning && <ReasoningBlock text={message.reasoning} />}
          <Markdown>{message.text}</Markdown>
        </div>
        {message.text && (
          <div className="mt-1 flex h-7 items-center">
            <CopyAction text={message.text} />
          </div>
        )}
      </div>
    </article>
  );
}

function UserMessage({ message }: { message: ChatMessage }) {
  const skillMatch = message.text.match(
    /^Use these skills for this request: ([^\n]+)\.\n\n([\s\S]*)$/,
  );
  const skills = skillMatch?.[1]?.split(", ").filter(Boolean) ?? [];
  const content = skillMatch?.[2] ?? message.text;

  return (
    <article className="flex justify-end py-1">
      <div className="max-w-[88%] rounded-2xl rounded-br-md bg-zinc-100 px-4 py-2.5 text-sm leading-6 text-zinc-900 sm:max-w-[80%] dark:bg-zinc-800 dark:text-zinc-100">
        {skills.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1.5 text-[11px] leading-5 text-zinc-500 dark:text-zinc-400">
            {skills.map((skill) => (
              <span key={skill} className="inline-flex items-center gap-1">
                <Sparkles className="h-3 w-3" />/{skill}
              </span>
            ))}
          </div>
        )}
        <div className="whitespace-pre-wrap">{content}</div>
      </div>
    </article>
  );
}

export function ChatView({ threadId }: { threadId: string }) {
  const state = useThreadState(threadId);
  const openThread = useApp((s) => s.openThread);
  const closeThread = useApp((s) => s.closeThread);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let active = true;
    setLoadError("");
    void openThread(threadId).catch((error: unknown) => {
      if (active) setLoadError(error instanceof Error ? error.message : "无法加载会话");
    });
    return () => {
      active = false;
      void closeThread(threadId);
    };
  }, [threadId, openThread, closeThread]);

  const entries = useMemo<TimelineEntry[]>(() => {
    const list: TimelineEntry[] = [
      ...state.messages.map((message) => ({
        type: "message" as const,
        at: message.createdAt,
        message,
      })),
      ...state.activities.map((activity) => ({
        type: "tool" as const,
        at: activity.startedAt,
        activity,
      })),
    ];
    list.sort((a, b) => a.at - b.at);
    return list;
  }, [state.messages, state.activities]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && pinnedRef.current) {
      element.scrollTop = element.scrollHeight;
      setAtBottom(true);
    }
  }, [entries, state.live.text, state.live.reasoning]);

  const onScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    const nextAtBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
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

  if (loadError) {
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

  const hasLive = state.live.text.length > 0 || state.live.reasoning.length > 0;
  const hasRunningTool = state.activities.some((activity) => activity.status === "running");

  return (
    <div className="relative h-full">
      <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-3 px-4 py-7 sm:px-6 sm:py-9">
          {entries.length === 0 && !hasLive && !state.running && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-16 text-zinc-400">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-zinc-100 dark:bg-zinc-900">
                <Bot className="h-5 w-5" />
              </div>
              <span className="text-sm">新会话</span>
            </div>
          )}

          {entries.map((entry) => {
            if (entry.type === "tool") {
              return (
                <div key={`tool-${entry.activity.id}`} className="pl-0 sm:pl-10">
                  <ToolCallRow activity={entry.activity} />
                </div>
              );
            }

            const message = entry.message;
            if (message.role === "system") {
              return (
                <div key={message.id} className="py-2 text-center text-xs text-zinc-400">
                  {message.text}
                </div>
              );
            }
            if (message.role === "user") {
              return <UserMessage key={message.id} message={message} />;
            }
            return <AssistantMessage key={message.id} message={message} />;
          })}

          {hasLive && (
            <article className="flex gap-3 py-1" aria-live="polite">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
                <Bot className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">
                  编码助手
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" />
                </div>
                <div className="space-y-2">
                  {state.live.reasoning && (
                    <ReasoningBlock text={state.live.reasoning} streaming />
                  )}
                  {state.live.text ? (
                    <Markdown>{state.live.text}</Markdown>
                  ) : (
                    <div className="flex items-center gap-2 text-sm text-zinc-400">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在处理
                    </div>
                  )}
                </div>
              </div>
            </article>
          )}

          {state.running && !hasLive && !hasRunningTool && (
            <div className="flex items-center gap-3 py-1 pl-0 text-sm text-zinc-400 sm:pl-10" aria-live="polite">
              <Loader2 className="h-4 w-4 animate-spin" /> 正在处理
            </div>
          )}

          {state.error && (
            <div className="ml-0 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700 sm:ml-10 dark:border-red-950 dark:bg-red-950/30 dark:text-red-300">
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
          className="absolute bottom-3 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-600 shadow-sm hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          onClick={scrollToBottom}
        >
          <ArrowDown className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
