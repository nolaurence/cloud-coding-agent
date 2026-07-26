import { useCallback, useEffect, useRef, useState } from "react";
import {
  AtSign,
  FileText,
  FolderGit2,
  Loader2,
  Send,
  Sparkles,
  Square,
} from "lucide-react";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";
import { Button } from "./ui/primitives";

interface Trigger {
  kind: "file" | "skill";
  start: number;
  query: string;
}

interface CompletionItem {
  key: string;
  label: string;
  hint?: string;
  kind: "file" | "skill";
}

function detectTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const match = before.match(/(^|\s)([@/])([^\s@/]*)$/);
  if (!match) return null;
  const symbol = match[2];
  const query = match[3] ?? "";
  const start = caret - query.length - 1;
  return { kind: symbol === "@" ? "file" : "skill", start, query };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function Composer({
  threadId,
  projectId,
  running,
  onSend,
  onInterrupt,
  autoFocus,
  placeholder,
}: {
  threadId?: string;
  projectId?: string;
  running: boolean;
  onSend: (
    text: string,
    attachments: { path: string; displayName?: string }[],
  ) => void | Promise<void>;
  onInterrupt?: () => void | Promise<void>;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const skills = useApp((state) => state.skills);
  const projects = useApp((state) => state.projects);
  const searchFiles = useApp((state) => state.searchFiles);
  const [text, setText] = useState("");
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [searchingFiles, setSearchingFiles] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const project = projects.find((candidate) => candidate.id === projectId);
  const busy = running || submitting;

  const resizeTextarea = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 192)}px`;
  }, []);

  useEffect(() => {
    resizeTextarea();
  }, [text, resizeTextarea]);

  const updateTrigger = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    setTrigger(detectTrigger(element.value, element.selectionStart ?? element.value.length));
    setActiveIndex(0);
  }, []);

  const fileQuery = trigger?.kind === "file" ? trigger.query : null;
  useEffect(() => {
    if (fileQuery === null || !projectId) {
      setFileResults([]);
      setSearchingFiles(false);
      return;
    }

    let cancelled = false;
    setFileResults([]);
    setSearchingFiles(true);
    const timer = window.setTimeout(() => {
      void searchFiles(projectId, fileQuery)
        .then((results) => {
          if (!cancelled) setFileResults(results);
        })
        .catch(() => {
          if (!cancelled) setFileResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearchingFiles(false);
        });
    }, 150);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fileQuery, projectId, searchFiles]);

  const skillResults =
    trigger?.kind === "skill"
      ? skills
          .filter(
            (skill) =>
              !skill.disabled &&
              (skill.name.toLowerCase().includes(trigger.query.toLowerCase()) ||
                skill.description.toLowerCase().includes(trigger.query.toLowerCase())),
          )
          .slice(0, 30)
      : [];

  const items: CompletionItem[] =
    trigger?.kind === "file"
      ? fileResults.slice(0, 30).map((file) => ({ key: file, label: file, kind: "file" }))
      : skillResults.map((skill) => ({
          key: skill.name,
          label: skill.name,
          hint: skill.description,
          kind: "skill",
        }));

  const popupVisible = trigger !== null && (trigger.kind === "skill" || Boolean(projectId));

  const applyItem = (itemKey: string) => {
    const element = textareaRef.current;
    if (!element || !trigger) return;
    const caret = element.selectionStart ?? text.length;
    const token = trigger.kind === "file" ? `@${itemKey}` : `/${itemKey}`;
    const next = text.slice(0, trigger.start) + token + " " + text.slice(caret);
    const nextCaret = trigger.start + token.length + 1;
    setText(next);
    setTrigger(null);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const insertTrigger = (symbol: "@" | "/") => {
    const element = textareaRef.current;
    if (!element) return;
    const start = element.selectionStart ?? text.length;
    const end = element.selectionEnd ?? start;
    const needsSpace = start > 0 && !/\s/.test(text[start - 1] ?? "");
    const insertion = `${needsSpace ? " " : ""}${symbol}`;
    const next = text.slice(0, start) + insertion + text.slice(end);
    const nextCaret = start + insertion.length;
    setText(next);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(nextCaret, nextCaret);
      updateTrigger();
    });
  };

  const buildPayload = () => {
    let prompt = text;
    const attachments: { path: string; displayName?: string }[] = [];
    if (project) {
      const seen = new Set<string>();
      const fileTokens = [...text.matchAll(/@([^\s@/]+(?:\/[^\s@]+)*)/g)].map(
        (match) => match[1]!,
      );
      for (const relativePath of fileTokens) {
        if (seen.has(relativePath)) continue;
        seen.add(relativePath);
        const separator = project.path.includes("\\") ? "\\" : "/";
        attachments.push({
          path:
            project.path.replace(/[\\/]+$/, "") +
            separator +
            relativePath.split("/").join(separator),
          displayName: relativePath,
        });
      }
      prompt = prompt.replace(/@([^\s@/]+(?:\/[^\s@]+)*)/g, "`$1`");
    }

    const usedSkills = skills.filter((skill) => {
      if (skill.disabled) return false;
      const pattern = new RegExp(`(^|\\s)/${escapeRegExp(skill.name)}(?=\\s|$)`);
      return pattern.test(text);
    });
    if (usedSkills.length > 0) {
      const names = usedSkills.map((skill) => skill.name).join(", ");
      const alternation = usedSkills.map((skill) => escapeRegExp(skill.name)).join("|");
      prompt = prompt.replace(new RegExp(`(^|\\s)/(?:${alternation})(?=\\s|$)`, "g"), "$1");
      prompt = `Use these skills for this request: ${names}.\n\n${prompt.trim()}`;
    }
    return { prompt: prompt.trim(), attachments };
  };

  const submit = async () => {
    if (busy) return;
    const { prompt, attachments } = buildPayload();
    if (!prompt && attachments.length === 0) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      await onSend(prompt, attachments);
      setText("");
      setTrigger(null);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "消息发送失败");
    } finally {
      setSubmitting(false);
    }
  };

  const stop = async () => {
    if (!onInterrupt || interrupting) return;
    setInterrupting(true);
    setSubmitError("");
    try {
      await onInterrupt();
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "停止任务失败");
    } finally {
      setInterrupting(false);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (popupVisible && items.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % items.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((index) => (index - 1 + items.length) % items.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const item = items[activeIndex];
        if (item) applyItem(item.key);
        return;
      }
    }
    if (event.key === "Escape" && trigger) {
      event.preventDefault();
      setTrigger(null);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (!busy) void submit();
    }
  };

  return (
    <div className="relative">
      {popupVisible && (
        <div className="absolute bottom-full left-0 z-50 mb-2 max-h-72 w-full overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1.5 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] font-medium text-zinc-500">
            {trigger.kind === "file" ? (
              <>
                <FileText className="h-3.5 w-3.5" /> 引用文件
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" /> 选择技能
              </>
            )}
            {searchingFiles && <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin" />}
          </div>
          {items.map((item, index) => (
            <button
              type="button"
              key={`${item.kind}-${item.key}`}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs",
                index === activeIndex
                  ? "bg-zinc-100 dark:bg-zinc-800"
                  : "hover:bg-zinc-50 dark:hover:bg-zinc-800/60",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={() => {
                applyItem(item.key);
              }}
              onMouseEnter={() => setActiveIndex(index)}
            >
              {item.kind === "file" ? (
                <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-violet-500" />
              )}
              <span className="mono min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && (
                <span className="hidden max-w-52 truncate text-zinc-400 sm:block">{item.hint}</span>
              )}
            </button>
          ))}
          {!searchingFiles && items.length === 0 && (
            <div className="px-2 py-4 text-center text-xs text-zinc-400">
              {trigger.kind === "file" ? "未找到匹配文件" : "未找到匹配技能"}
            </div>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-zinc-300 bg-white shadow-sm transition-colors focus-within:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-zinc-500">
        <textarea
          ref={textareaRef}
          autoFocus={autoFocus}
          aria-label="消息内容"
          disabled={submitting}
          rows={1}
          className="block min-h-20 w-full resize-none overflow-y-auto bg-transparent px-4 pt-3.5 pb-2 text-sm leading-6 outline-none placeholder:text-zinc-400 disabled:opacity-60"
          placeholder={placeholder ?? "输入消息"}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setSubmitError("");
            requestAnimationFrame(updateTrigger);
          }}
          onKeyDown={onKeyDown}
          onClick={updateTrigger}
          onKeyUp={(event) => {
            if (!["Enter", "ArrowDown", "ArrowUp", "Tab"].includes(event.key)) updateTrigger();
          }}
        />

        {submitError && (
          <div className="px-4 pb-2 text-xs text-red-600 dark:text-red-400" role="alert">
            {submitError}
          </div>
        )}

        <div className="flex min-h-11 items-center justify-between gap-2 px-2.5 pb-2.5">
          <div className="flex min-w-0 items-center gap-1">
            <button
              type="button"
              aria-label="引用文件"
              title="引用文件"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              onClick={() => insertTrigger("@")}
            >
              <AtSign className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="选择技能"
              title="选择技能"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              onClick={() => insertTrigger("/")}
            >
              <Sparkles className="h-4 w-4" />
            </button>
            {project && (
              <span className="ml-1 hidden min-w-0 items-center gap-1.5 text-xs text-zinc-400 sm:flex" title={project.path}>
                <FolderGit2 className="h-3.5 w-3.5 shrink-0" />
                <span className="max-w-48 truncate">{project.name}</span>
              </span>
            )}
            {threadId && running && (
              <span className="ml-1 hidden text-xs text-zinc-400 sm:inline">任务运行中</span>
            )}
          </div>

          {running && onInterrupt ? (
            <Button
              type="button"
              size="icon"
              aria-label="停止任务"
              title="停止任务"
              className="h-9 w-9 shrink-0 rounded-full"
              onClick={() => void stop()}
              disabled={interrupting}
            >
              {interrupting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Square className="h-3.5 w-3.5 fill-current" />
              )}
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              aria-label="发送消息"
              title="发送消息"
              className="h-9 w-9 shrink-0 rounded-full"
              onClick={() => void submit()}
              disabled={!text.trim() || busy}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
