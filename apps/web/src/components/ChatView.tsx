import { useEffect, useMemo, useRef } from "react";
import { Brain, ChevronRight, Loader2, User } from "lucide-react";
import { useState } from "react";
import type { ChatMessage, ToolActivity } from "@cca/protocol";
import { useApp, useThreadState } from "../lib/store";
import { Markdown } from "./Markdown";
import { ToolCallRow } from "./ToolCallRow";
import { cn } from "../lib/utils";

type TimelineEntry =
  | { type: "message"; at: number; message: ChatMessage }
  | { type: "tool"; at: number; activity: ToolActivity };

function ReasoningBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-zinc-200 text-xs dark:border-zinc-800">
      <button
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-zinc-500"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} />
        <Brain className="h-3.5 w-3.5" />
        {streaming ? "思考中…" : "思考过程"}
      </button>
      {open && (
        <div className="border-t border-zinc-200 px-3 py-2 whitespace-pre-wrap text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          {text}
        </div>
      )}
    </div>
  );
}

export function ChatView({ threadId }: { threadId: string }) {
  const state = useThreadState(threadId);
  const openThread = useApp((s) => s.openThread);
  const closeThread = useApp((s) => s.closeThread);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  useEffect(() => {
    void openThread(threadId);
    return () => {
      void closeThread(threadId);
    };
  }, [threadId, openThread, closeThread]);

  const entries = useMemo<TimelineEntry[]>(() => {
    const list: TimelineEntry[] = [
      ...state.messages.map((m) => ({ type: "message" as const, at: m.createdAt, message: m })),
      ...state.activities.map((a) => ({ type: "tool" as const, at: a.startedAt, activity: a })),
    ];
    list.sort((a, b) => a.at - b.at);
    return list;
  }, [state.messages, state.activities]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [entries.length, state.live.text, state.live.reasoning]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  if (!state.loaded) {
    return (
      <div className="flex h-full items-center justify-center text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  const hasLive = state.live.text.length > 0 || state.live.reasoning.length > 0;

  return (
    <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-6">
        {entries.length === 0 && !hasLive && (
          <div className="py-16 text-center text-sm text-zinc-400">开始对话吧</div>
        )}
        {entries.map((entry) => {
          if (entry.type === "tool") {
            return <ToolCallRow key={`tool-${entry.activity.id}`} activity={entry.activity} />;
          }
          const m = entry.message;
          if (m.role === "user") {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-blue-600 px-4 py-2.5 text-sm whitespace-pre-wrap text-white">
                  <div className="mb-1 flex items-center gap-1 text-[10px] text-blue-200">
                    <User className="h-3 w-3" /> 你
                  </div>
                  {m.text}
                </div>
              </div>
            );
          }
          return (
            <div key={m.id} className="flex flex-col gap-2">
              {m.reasoning && <ReasoningBlock text={m.reasoning} />}
              <Markdown>{m.text}</Markdown>
            </div>
          );
        })}
        {hasLive && (
          <div className="flex flex-col gap-2">
            {state.live.reasoning && <ReasoningBlock text={state.live.reasoning} streaming />}
            {state.live.text ? (
              <Markdown>{state.live.text}</Markdown>
            ) : (
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <Loader2 className="h-4 w-4 animate-spin" /> 正在生成…
              </div>
            )}
          </div>
        )}
        {state.running && !hasLive && (
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Agent 运行中…
          </div>
        )}
        {state.error && (
          <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300">
            {state.error}
          </div>
        )}
      </div>
    </div>
  );
}
