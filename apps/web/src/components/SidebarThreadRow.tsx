import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Archive,
  Ellipsis,
  Eye,
  GitFork,
  Loader2,
  MessagesSquare,
  Pencil,
  Pin,
} from "lucide-react";
import { DropdownMenu } from "radix-ui";
import type { ThreadMeta } from "@cca/protocol";
import { THREAD_TITLE_MAX_LENGTH } from "@cca/protocol";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";
import { Kbd } from "@/components/ui/kbd";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

function Shortcut({ keys }: { keys: string[] }) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5 text-label-3">
      {keys.map((key) => (
        <Kbd key={key} className="h-4 min-w-4 bg-transparent px-0.5 text-[10px] text-label-3">
          {key}
        </Kbd>
      ))}
    </span>
  );
}

export function SidebarThreadRow({
  thread,
  manage,
  active,
  running,
  renaming,
  onRenameStart,
  onRenameEnd,
  onNavigate,
  relativeTime,
}: {
  thread: ThreadMeta;
  manage: boolean;
  active: boolean;
  running: boolean;
  renaming: boolean;
  onRenameStart: () => void;
  onRenameEnd: () => void;
  onNavigate?: () => void;
  relativeTime: (at: number) => string;
}) {
  const navigate = useNavigate();
  const setThreadPinned = useApp((s) => s.setThreadPinned);
  const setThreadArchived = useApp((s) => s.setThreadArchived);
  const renameThread = useApp((s) => s.renameThread);
  const forkThread = useApp((s) => s.forkThread);
  const inputRef = useRef<HTMLInputElement>(null);
  const skipBlurSave = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState(thread.title);
  const [busy, setBusy] = useState<"pin" | "archive" | "rename" | "fork" | null>(null);
  const [error, setError] = useState("");
  const pinned = thread.pinnedAt !== undefined;

  useEffect(() => {
    if (!renaming) return;
    skipBlurSave.current = false;
    setDraft(thread.title);
    setError("");
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [renaming, thread.title]);

  const status = running
    ? <Loader2 className="size-3.5 animate-spin text-[var(--ds-link)]" strokeWidth={1.8} />
    : thread.access === "readonly"
      ? <Eye className="size-3.5 text-label-3" strokeWidth={1.8} />
      : thread.access === "collaborate"
        ? <MessagesSquare className="size-3.5 text-label-3" strokeWidth={1.8} />
        : null;

  const run = async (kind: "pin" | "archive" | "rename" | "fork", task: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    setError("");
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(null);
    }
  };

  const saveRename = () => {
    const title = draft.replace(/\s+/g, " ").trim();
    if (!title || title === thread.title) {
      onRenameEnd();
      return;
    }
    void run("rename", async () => {
      await renameThread(thread.id, title);
      onRenameEnd();
    });
  };

  const fork = () =>
    run("fork", async () => {
      const created = await forkThread(thread.id);
      navigate(`/thread/${created.id}`);
      onNavigate?.();
    });

  return (
    <div
      className="group/thread relative"
      onContextMenu={(event) => {
        if (!manage || renaming) return;
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      {renaming ? (
        <div className="flex h-8 items-center gap-1.5 rounded-[12px] bg-hover px-2">
          <span className="flex size-4 shrink-0 items-center justify-center">{status}</span>
          <input
            ref={inputRef}
            value={draft}
            maxLength={THREAD_TITLE_MAX_LENGTH}
            aria-label="会话标题"
            disabled={busy === "rename"}
            className="min-w-0 flex-1 bg-transparent text-[14px] leading-5 text-label-1 outline-none"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => {
              if (skipBlurSave.current) {
                skipBlurSave.current = false;
                return;
              }
              saveRename();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.blur();
              } else if (event.key === "Escape") {
                event.preventDefault();
                skipBlurSave.current = true;
                onRenameEnd();
              }
            }}
          />
        </div>
      ) : (
        <Link
          to={`/thread/${thread.id}`}
          onClick={onNavigate}
          title={
            thread.access === "readonly"
              ? `${thread.title}（只读分享）`
              : thread.access === "collaborate"
                ? `${thread.title}（可加入分享）`
                : thread.title
          }
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-[12px] px-2 text-[14px] leading-5 text-label-1 transition-colors hover:bg-hover",
            active && "bg-hover",
          )}
        >
          <span className="flex size-4 shrink-0 items-center justify-center">{status}</span>
          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
          {pinned && (
            <Pin
              className={cn(
                "size-3 shrink-0 text-label-3 transition-opacity",
                manage && !active && "group-hover/thread:opacity-0 group-focus-within/thread:opacity-0",
                (active || menuOpen) && "opacity-0",
              )}
              strokeWidth={1.8}
              aria-label="已置顶"
            />
          )}
          <span
            className={cn(
              "shrink-0 text-[11px] leading-4 tabular-nums text-label-3 transition-opacity",
              manage && !active && "group-hover/thread:opacity-0 group-focus-within/thread:opacity-0",
              (active || menuOpen) && "opacity-0",
            )}
          >
            {relativeTime(thread.updatedAt)}
          </span>
        </Link>
      )}
      {manage && !renaming && (
        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label={`会话操作 ${thread.title}`}
              title="会话操作"
              className={cn(
                "absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded-[6px] text-label-3 transition-colors hover:bg-hover hover:text-label-1",
                active || menuOpen
                  ? "pointer-events-auto opacity-100"
                  : "pointer-events-none opacity-0 group-hover/thread:pointer-events-auto group-hover/thread:opacity-100 group-focus-within/thread:pointer-events-auto group-focus-within/thread:opacity-100",
              )}
              disabled={busy !== null}
            >
              {busy ? (
                <Loader2 className="size-3.5 animate-spin" strokeWidth={1.8} />
              ) : (
                <Ellipsis className="size-3.5" strokeWidth={1.8} />
              )}
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              sideOffset={6}
              align="end"
              collisionPadding={8}
              className="z-50 min-w-[220px] rounded-[12px] border-[0.5px] border-line-3 bg-elevated p-1.5 text-label-1 shadow-[0_8px_24px_rgb(15_23_42/0.12)] outline-none dark:shadow-[0_8px_24px_rgb(0_0_0/0.4)]"
            >
              <DropdownMenu.Item
                className="flex h-8 cursor-default select-none items-center gap-2 rounded-[8px] px-2 text-[13px] leading-5 outline-none data-[highlighted]:bg-hover"
                disabled={busy !== null}
                onSelect={() => {
                  void run("pin", async () => {
                    await setThreadPinned(thread.id, !pinned);
                  });
                }}
              >
                <Pin className={cn("size-3.5 text-label-3", pinned && "fill-current text-[var(--ds-link)]")} strokeWidth={1.8} />
                <span className="flex-1">{pinned ? "取消置顶" : "置顶会话"}</span>
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="flex h-8 cursor-default select-none items-center gap-2 rounded-[8px] px-2 text-[13px] leading-5 outline-none data-[highlighted]:bg-hover"
                disabled={busy !== null}
                onSelect={() => onRenameStart()}
              >
                <Pencil className="size-3.5 text-label-3" strokeWidth={1.8} />
                <span className="flex-1">重命名</span>
                <Shortcut keys={["Ctrl", "Alt", "G"]} />
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="flex h-8 cursor-default select-none items-center gap-2 rounded-[8px] px-2 text-[13px] leading-5 outline-none data-[highlighted]:bg-hover"
                disabled={busy !== null}
                onSelect={() => void fork()}
              >
                <GitFork className="size-3.5 text-label-3" strokeWidth={1.8} />
                <span className="flex-1">分叉会话</span>
                <Shortcut keys={["Ctrl", "Alt", "F"]} />
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="mx-1 my-1 h-px bg-line-2" />
              <DropdownMenu.Item
                className="flex h-8 cursor-default select-none items-center gap-2 rounded-[8px] px-2 text-[13px] leading-5 outline-none data-[highlighted]:bg-hover"
                disabled={busy !== null}
                onSelect={() => {
                  void run("archive", async () => {
                    await setThreadArchived(thread.id, true);
                    if (active) {
                      navigate("/");
                      onNavigate?.();
                    }
                  });
                }}
              >
                <Archive className="size-3.5 text-label-3" strokeWidth={1.8} />
                <span className="flex-1">归档会话</span>
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
      {error && (
        <div role="alert" className="px-2 pb-1 text-[11px] leading-4 text-red-600 dark:text-red-400">
          {error}
        </div>
      )}
    </div>
  );
}

export function isSessionShortcutTarget(target: EventTarget | null): boolean {
  return isTypingTarget(target);
}
