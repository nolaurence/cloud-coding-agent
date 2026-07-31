import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  AtSign,
  FileText,
  ImagePlus,
  Loader2,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { uploadImage } from "../lib/client";
import type { TurnAttachment } from "@cca/protocol";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";

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

const actionButtonClass =
  "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black text-white transition-[background-color,color,transform] hover:bg-zinc-800 active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:bg-zinc-200 disabled:text-zinc-400 max-[359px]:ml-auto dark:bg-white dark:text-black dark:hover:bg-zinc-200 dark:focus-visible:ring-offset-zinc-900 dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400";

const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_IMAGES = 4;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
let nextImageId = 0;

interface PendingImage {
  id: string;
  file: File;
  previewUrl: string;
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
  draftKey,
  threadId,
  projectId,
  running,
  onSend,
  onInterrupt,
  autoFocus,
  placeholder,
  footerControls,
  footerError,
}: {
  draftKey: string;
  threadId?: string;
  projectId?: string;
  running: boolean;
  onSend: (
    text: string,
    attachments: TurnAttachment[],
  ) => void | Promise<void>;
  onInterrupt?: () => void | Promise<void>;
  autoFocus?: boolean;
  placeholder?: string;
  footerControls?: ReactNode;
  footerError?: string;
}) {
  const skills = useApp((state) => state.skills);
  const projects = useApp((state) => state.projects);
  const searchFiles = useApp((state) => state.searchFiles);
  const text = useApp((state) => state.composerDrafts[draftKey] ?? "");
  const setComposerDraft = useApp((state) => state.setComposerDraft);
  const clearComposerDraft = useApp((state) => state.clearComposerDraft);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [searchingFiles, setSearchingFiles] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [interrupting, setInterrupting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [draggingImage, setDraggingImage] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

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
    setComposerDraft(draftKey, next);
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
    setComposerDraft(draftKey, next);
    requestAnimationFrame(() => {
      element.focus();
      element.setSelectionRange(nextCaret, nextCaret);
      updateTrigger();
    });
  };

  const addImages = (files: Iterable<File>) => {
    const candidates = [...files].filter((file) => file.type.startsWith("image/"));
    if (candidates.length === 0) return;
    setSubmitError("");
    const valid: File[] = [];
    for (const file of candidates) {
      if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
        setSubmitError("仅支持 JPG、PNG、GIF 和 WebP 图片");
        continue;
      }
      if (file.size > MAX_IMAGE_SIZE) {
        setSubmitError(`图片 ${file.name} 超过 10 MB`);
        continue;
      }
      valid.push(file);
    }
    setImages((current) => {
      const available = MAX_IMAGES - current.length;
      if (valid.length > available) setSubmitError(`一次最多添加 ${MAX_IMAGES} 张图片`);
      return [
        ...current,
        ...valid.slice(0, Math.max(0, available)).map((file) => ({
          id: `image-${++nextImageId}`,
          file,
          previewUrl: URL.createObjectURL(file),
        })),
      ];
    });
  };

  const removeImage = (id: string) => {
    setImages((current) => {
      const removed = current.find((image) => image.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return current.filter((image) => image.id !== id);
    });
  };

  const buildPayload = () => {
    let prompt = text;
    const attachments: TurnAttachment[] = [];
    if (project) {
      const seen = new Set<string>();
      const fileTokens = [...text.matchAll(/@([^\s@/]+(?:\/[^\s@]+)*)/g)].map(
        (match) => match[1]!,
      );
      for (const relativePath of fileTokens) {
        if (seen.has(relativePath)) continue;
        seen.add(relativePath);
        attachments.push({
          path: relativePath,
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
    if (!prompt && attachments.length === 0 && images.length === 0) return;
    setSubmitting(true);
    setSubmitError("");
    try {
      const imageAttachments = await Promise.all(images.map((image) => uploadImage(image.file)));
      await onSend(prompt, [...attachments, ...imageAttachments]);
      clearComposerDraft(draftKey, text);
      setTrigger(null);
      images.forEach((image) => URL.revokeObjectURL(image.previewUrl));
      setImages([]);
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
    <div className="relative" data-thread-id={threadId}>
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

      <div
        className={cn(
          "rounded-2xl border border-zinc-300 bg-white shadow-[0_12px_32px_-20px_rgba(0,0,0,0.28),0_3px_10px_-7px_rgba(0,0,0,0.2)] transition-colors focus-within:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-[0_12px_32px_-20px_rgba(0,0,0,0.65),0_3px_10px_-7px_rgba(0,0,0,0.4)] dark:focus-within:border-zinc-500",
          draggingImage && "border-blue-500 bg-blue-50/50 dark:border-blue-400 dark:bg-blue-950/20",
        )}
        onDragEnter={(event) => {
          if ([...event.dataTransfer.items].some((item) => item.type.startsWith("image/"))) {
            event.preventDefault();
            setDraggingImage(true);
          }
        }}
        onDragOver={(event) => {
          if ([...event.dataTransfer.items].some((item) => item.type.startsWith("image/"))) {
            event.preventDefault();
          }
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingImage(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDraggingImage(false);
          addImages(event.dataTransfer.files);
        }}
      >
        {images.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-4 pt-3">
            {images.map((image) => (
              <div className="group relative h-16 w-16 shrink-0" key={image.id}>
                <img
                  src={image.previewUrl}
                  alt={image.file.name}
                  className="h-full w-full rounded-lg border border-zinc-200 object-cover dark:border-zinc-700"
                />
                <button
                  type="button"
                  aria-label={`移除图片 ${image.file.name}`}
                  title="移除图片"
                  className="absolute -top-1.5 -right-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-800 text-white shadow hover:bg-black"
                  onClick={() => removeImage(image.id)}
                  disabled={submitting}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}
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
            setComposerDraft(draftKey, event.target.value);
            setSubmitError("");
            requestAnimationFrame(updateTrigger);
          }}
          onKeyDown={onKeyDown}
          onPaste={(event) => {
            const pastedImages = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith("image/"),
            );
            if (pastedImages.length > 0) {
              event.preventDefault();
              addImages(pastedImages);
            }
          }}
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
        {footerError && (
          <div className="px-4 pb-2 text-xs text-red-600 dark:text-red-400" role="alert">
            {footerError}
          </div>
        )}

        <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-2 gap-y-1 px-2.5 pb-2.5">
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-visible max-[359px]:basis-full">
            {footerControls && (
              <div className="flex min-w-0 items-center gap-1">{footerControls}</div>
            )}
            <input
              ref={imageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              multiple
              className="hidden"
              onChange={(event) => {
                if (event.target.files) addImages(event.target.files);
                event.target.value = "";
              }}
            />
            <button
              type="button"
              aria-label="添加图片"
              title="添加图片"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800 disabled:opacity-50 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              onClick={() => imageInputRef.current?.click()}
              disabled={busy || images.length >= MAX_IMAGES}
            >
              <ImagePlus className="h-4 w-4" />
            </button>
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
          </div>

          {running && onInterrupt ? (
            <button
              type="button"
              aria-label="停止任务"
              title="停止任务"
              className={actionButtonClass}
              onClick={() => void stop()}
              disabled={interrupting}
              aria-busy={interrupting}
            >
              {interrupting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Square className="h-3.5 w-3.5 fill-current" />
              )}
            </button>
          ) : (
            <button
              type="button"
              aria-label="发送消息"
              title="发送消息"
              className={actionButtonClass}
              onClick={() => void submit()}
              disabled={(!text.trim() && images.length === 0) || busy}
              aria-busy={submitting}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-5 w-5 stroke-[2.5]" />
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
