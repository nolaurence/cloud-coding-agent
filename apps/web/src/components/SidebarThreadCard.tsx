import { Link } from "react-router-dom";
import {
  Archive,
  Cpu,
  Eye,
  GitPullRequest,
  Loader2,
  MessagesSquare,
  Pin,
  Sparkles,
} from "lucide-react";
import {
  DEFAULT_AGENT_RUNTIME,
  type AgentRuntime,
  type ThreadMeta,
  type Workspace,
} from "@cca/protocol";
import { cn } from "../lib/utils";
import { compactSidebarTime, threadGitPresentation } from "../lib/threadGroups";
import { deriveProjectIdentity } from "../lib/projectIdentity";

function ProjectBadge({ name }: { name: string }) {
  const identity = deriveProjectIdentity(name);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] text-[9px] font-semibold tracking-tight",
        identity.bgClassName,
        identity.textClassName,
      )}
    >
      {identity.monogram}
    </span>
  );
}

function RuntimeGlyph({ runtime }: { runtime: AgentRuntime | undefined }) {
  const kind = runtime ?? DEFAULT_AGENT_RUNTIME;
  const Icon = kind === "dsh" ? Sparkles : Cpu;
  const label = kind === "dsh" ? "DeepSeek Harness" : "Codex";
  return (
    <Icon
      className="size-3.5 shrink-0 text-label-3"
      strokeWidth={1.8}
      aria-label={label}
    />
  );
}

export function SidebarThreadCard({
  thread,
  project,
  active,
  running,
  manage,
  onNavigate,
  onTogglePinned,
  onArchive,
}: {
  thread: ThreadMeta;
  project: Workspace | undefined;
  active: boolean;
  running: boolean;
  manage: boolean;
  onNavigate?: () => void;
  onTogglePinned: (thread: ThreadMeta) => void;
  onArchive: (thread: ThreadMeta) => void;
}) {
  const pinned = thread.pinnedAt !== undefined;
  const git = threadGitPresentation(thread);
  const projectName = project?.name ?? (thread.access && thread.access !== "owner" ? "共享" : "工作区");
  const shareLabel =
    thread.access === "readonly"
      ? "（只读分享）"
      : thread.access === "collaborate"
        ? "（可加入分享）"
        : "";
  const showActions = manage && active;

  return (
    <div className="group/thread relative">
      <Link
        to={`/thread/${thread.id}`}
        onClick={onNavigate}
        title={`${thread.title}${shareLabel}`}
        className={cn(
          "flex flex-col gap-0.5 rounded-[12px] px-2.5 py-2 transition-colors hover:bg-hover",
          active && "bg-hover",
        )}
      >
        <div className="relative flex min-w-0 items-center gap-1.5">
          <ProjectBadge name={projectName} />
          <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-label-3">
            {projectName}
          </span>
          {running && (
            <Loader2
              className="size-3.5 shrink-0 animate-spin text-[var(--ds-link)]"
              strokeWidth={1.8}
              aria-label="正在运行"
            />
          )}
          {pinned && (
            <Pin
              className={cn(
                "size-3 shrink-0 text-label-3",
                manage && "group-hover/thread:invisible group-focus-within/thread:invisible",
                showActions && "invisible",
              )}
              strokeWidth={1.8}
              aria-label="已置顶"
            />
          )}
          <span
            className={cn(
              "w-12 shrink-0 text-right text-[12px] leading-4 tabular-nums text-label-3",
              manage && "group-hover/thread:invisible group-focus-within/thread:invisible",
              showActions && "invisible",
            )}
          >
            {compactSidebarTime(thread.updatedAt)}
          </span>
          {manage && (
            <div
              className={cn(
                "absolute right-0 top-1/2 flex w-12 -translate-y-1/2 items-center justify-end gap-0.5",
                showActions
                  ? "visible"
                  : "invisible group-hover/thread:visible group-focus-within/thread:visible",
              )}
            >
              <button
                type="button"
                aria-label={pinned ? `取消置顶 ${thread.title}` : `置顶 ${thread.title}`}
                title={pinned ? "取消置顶" : "置顶"}
                className="flex size-6 items-center justify-center rounded-[6px] text-label-3 transition-colors hover:bg-hover hover:text-label-1"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onTogglePinned(thread);
                }}
              >
                <Pin
                  className={cn("size-3.5", pinned && "fill-current text-[var(--ds-link)]")}
                  strokeWidth={1.8}
                />
              </button>
              <button
                type="button"
                aria-label={`归档会话 ${thread.title}`}
                title="归档"
                className="flex size-6 items-center justify-center rounded-[6px] text-label-3 transition-colors hover:bg-hover hover:text-label-1"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onArchive(thread);
                }}
              >
                <Archive className="size-3.5" strokeWidth={1.8} />
              </button>
            </div>
          )}
        </div>
        <div className="flex min-w-0 items-center">
          <span className="min-w-0 flex-1 truncate text-[15px] font-normal leading-5 text-label-1">
            {thread.title}
          </span>
        </div>
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12px] leading-4 text-label-3">
            {git.branch}
          </span>
          {thread.access === "readonly" ? (
            <Eye className="size-3.5 shrink-0 text-label-3" strokeWidth={1.8} aria-label="只读分享" />
          ) : thread.access === "collaborate" ? (
            <MessagesSquare className="size-3.5 shrink-0 text-label-3" strokeWidth={1.8} aria-label="可加入分享" />
          ) : null}
          {git.pullRequestNumber !== undefined && (
            <span className="inline-flex shrink-0 items-center gap-0.5 text-[12px] leading-4 text-label-3">
              <GitPullRequest className="size-3.5" strokeWidth={1.8} aria-hidden="true" />
              {git.pullRequestNumber}
            </span>
          )}
          <span className="flex w-12 shrink-0 items-center justify-end">
            <RuntimeGlyph runtime={thread.runtime} />
          </span>
        </div>
      </Link>
    </div>
  );
}
