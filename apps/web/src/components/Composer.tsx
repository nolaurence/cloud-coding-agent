import { useCallback, useEffect, useRef, useState } from "react";
import { AtSign, FileText, Send, Sparkles, Square } from "lucide-react";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";
import { Button } from "./ui/primitives";

interface Trigger {
  kind: "file" | "skill";
  start: number;
  query: string;
}

function detectTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const match = before.match(/(^|\s)([@/])([^\s@/]*)$/);
  if (!match) return null;
  const symbol = match[2];
  const query = match[3] ?? "";
  const start = caret - query.length - 1;
  if (symbol === "@") return { kind: "file", start, query };
  return { kind: "skill", start, query };
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
  onSend: (text: string, attachments: { path: string; displayName?: string }[]) => void;
  onInterrupt?: () => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const skills = useApp((s) => s.skills);
  const projects = useApp((s) => s.projects);
  const searchFiles = useApp((s) => s.searchFiles);
  const [text, setText] = useState("");
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const project = projects.find((p) => p.id === projectId);

  const updateTrigger = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const t = detectTrigger(el.value, el.selectionStart ?? el.value.length);
    setTrigger(t);
    setActiveIndex(0);
  }, []);

  useEffect(() => {
    if (!trigger || trigger.kind !== "file" || !projectId) {
      setFileResults([]);
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      searchFiles(projectId, trigger.query)
        .then(setFileResults)
        .catch(() => setFileResults([]));
    }, 150);
  }, [trigger, projectId, searchFiles]);

  const skillResults =
    trigger?.kind === "skill"
      ? skills.filter(
          (sk) =>
            !sk.disabled &&
            (sk.name.toLowerCase().includes(trigger.query.toLowerCase()) ||
              sk.description.toLowerCase().includes(trigger.query.toLowerCase())),
        )
      : [];

  const items: { key: string; label: string; hint?: string; kind: "file" | "skill" }[] =
    trigger?.kind === "file"
      ? fileResults.map((f) => ({ key: f, label: f, kind: "file" as const }))
      : skillResults.map((sk) => ({ key: sk.name, label: sk.name, hint: sk.description, kind: "skill" as const }));

  const popupOpen = trigger !== null && items.length > 0;

  const applyItem = (itemKey: string) => {
    const el = textareaRef.current;
    if (!el || !trigger) return;
    const caret = el.selectionStart ?? text.length;
    const token = trigger.kind === "file" ? `@${itemKey}` : `/${itemKey}`;
    const next = text.slice(0, trigger.start) + token + " " + text.slice(caret);
    setText(next);
    setTrigger(null);
    requestAnimationFrame(() => {
      const pos = trigger.start + token.length + 1;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const buildPayload = () => {
    let prompt = text;
    const attachments: { path: string; displayName?: string }[] = [];
    if (project) {
      const fileTokens = [...text.matchAll(/@([^\s@/]+(?:\/[^\s@]+)*)/g)].map((m) => m[1]!);
      for (const rel of fileTokens) {
        const sep = project.path.includes("\\") ? "\\" : "/";
        attachments.push({
          path: project.path.replace(/[\\/]+$/, "") + sep + rel.split("/").join(sep),
          displayName: rel,
        });
      }
      prompt = prompt.replace(/@([^\s@/]+(?:\/[^\s@]+)*)/g, "`$1`");
    }
    const usedSkills = skills.filter((sk) => new RegExp(`(^|\\s)/${sk.name}(\\s|$)`).test(text));
    if (usedSkills.length > 0) {
      const names = usedSkills.map((sk) => sk.name).join(", ");
      prompt = prompt.replace(new RegExp(`(^|\\s)/(${usedSkills.map((s) => s.name).join("|")})(?=\\s|$)`, "g"), "$1");
      prompt = `Use these skills for this request: ${names}.\n\n${prompt.trim()}`;
    }
    return { prompt: prompt.trim(), attachments };
  };

  const submit = () => {
    const { prompt, attachments } = buildPayload();
    if (!prompt && attachments.length === 0) return;
    onSend(prompt, attachments);
    setText("");
    setTrigger(null);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (popupOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + items.length) % items.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        const item = items[activeIndex];
        if (item) applyItem(item.key);
        return;
      }
      if (e.key === "Escape") {
        setTrigger(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (!running) submit();
    }
  };

  return (
    <div className="relative">
      {popupOpen && (
        <div className="absolute bottom-full left-0 z-50 mb-1 max-h-64 w-full overflow-y-auto rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
          <div className="px-2 py-1 text-[10px] font-medium tracking-wide text-zinc-400 uppercase">
            {trigger?.kind === "file" ? "引用文件" : "选择技能"}
          </div>
          {items.map((item, i) => (
            <button
              key={`${item.kind}-${item.key}`}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                i === activeIndex ? "bg-zinc-100 dark:bg-zinc-800" : "",
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                applyItem(item.key);
              }}
              onMouseEnter={() => setActiveIndex(i)}
            >
              {item.kind === "file" ? (
                <FileText className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              ) : (
                <Sparkles className="h-3.5 w-3.5 shrink-0 text-purple-400" />
              )}
              <span className="mono min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && <span className="max-w-40 truncate text-zinc-400">{item.hint}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="rounded-xl border border-zinc-300 bg-white shadow-sm focus-within:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:focus-within:border-zinc-500">
        <textarea
          ref={textareaRef}
          autoFocus={autoFocus}
          className="max-h-48 min-h-20 w-full resize-none bg-transparent px-3.5 py-3 text-sm outline-none placeholder:text-zinc-400"
          placeholder={placeholder ?? "描述你的任务… 输入 @ 引用文件,/ 选择技能,Enter 发送"}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            requestAnimationFrame(updateTrigger);
          }}
          onKeyDown={onKeyDown}
          onClick={updateTrigger}
          onKeyUp={(e) => {
            if (!["Enter", "ArrowDown", "ArrowUp", "Tab"].includes(e.key)) updateTrigger();
          }}
        />
        <div className="flex items-center justify-between px-2.5 pb-2">
          <div className="flex items-center gap-2 text-[11px] text-zinc-400">
            <span className="flex items-center gap-1">
              <AtSign className="h-3 w-3" /> 文件
            </span>
            <span className="flex items-center gap-1">
              <Sparkles className="h-3 w-3" /> / 技能
            </span>
            {threadId && running && <span className="text-blue-500">正在运行…</span>}
          </div>
          {running && onInterrupt ? (
            <Button size="sm" variant="destructive" onClick={onInterrupt}>
              <Square className="h-3 w-3" /> 停止
            </Button>
          ) : (
            <Button size="sm" onClick={submit} disabled={!text.trim()}>
              <Send className="h-3.5 w-3.5" /> 发送
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
