import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { FolderGit2, PanelRightOpen, Share2 } from "lucide-react";
import { useParams } from "react-router-dom";
import type { ModelRef } from "@cca/protocol";
import { useApp, useThreadState } from "../lib/store";
import { threadComposerDraftKey } from "../lib/composerDrafts";
import { ChatView } from "../components/ChatView";
import { Composer } from "../components/Composer";
import { ModelPicker } from "../components/ModelPicker";
import { ReasoningEffortPicker } from "../components/ReasoningEffortPicker";
import { RightPanel } from "../components/RightPanel";
import { RightPanelResizeHandle } from "../components/RightPanelResizeHandle";
import { ThreadShareDialog } from "../components/ThreadShareDialog";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { Button } from "@/components/ui/button";

const RIGHT_PANEL_WIDTH_STORAGE_KEY = "cloud-coding-agent:right-panel-width";
const RIGHT_PANEL_DEFAULT_WIDTH = 540;
const RIGHT_PANEL_MIN_WIDTH = 320;
const RIGHT_PANEL_MAX_WIDTH = 1400;
const RIGHT_PANEL_MAX_FRACTION = 0.7;
const CHAT_COLUMN_MIN_WIDTH = 400;
const RESIZE_HANDLE_WIDTH = 8;

export function ThreadPage() {
  const { threadId } = useParams<{ threadId: string }>();
  const threads = useApp((s) => s.threads);
  const projects = useApp((s) => s.projects);
  const settings = useApp((s) => s.settings);
  const sendMessage = useApp((s) => s.sendMessage);
  const interrupt = useApp((s) => s.interrupt);
  const compactContext = useApp((s) => s.compactContext);
  const setThreadModel = useApp((s) => s.setThreadModel);
  const panelOpen = useApp((s) => s.workspacePanelOpen);
  const setPanelOpen = useApp((s) => s.setWorkspacePanelOpen);
  const shareDialogOpen = useApp((s) => s.shareDialogOpen);
  const setShareDialogOpen = useApp((s) => s.setShareDialogOpen);
  const state = useThreadState(threadId);
  const thread = threads.find((t) => t.id === threadId);
  const project = projects.find((candidate) => candidate.id === thread?.projectId);
  const canManageThread = thread?.access === "owner";
  const canInteract = canManageThread || thread?.access === "collaborate";
  const [switchingModel, setSwitchingModel] = useState(false);
  const [modelError, setModelError] = useState("");
  const [composerHeight, setComposerHeight] = useState(0);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const layoutRef = useRef<HTMLDivElement>(null);
  const composerOverlayRef = useRef<HTMLDivElement>(null);
  const modelRequestRef = useRef(0);
  const effectiveModel = thread?.model ?? settings?.defaultModel;
  const panelMaxWidth = useMemo(() => {
    if (layoutWidth === 0) return RIGHT_PANEL_DEFAULT_WIDTH;
    return Math.max(
      RIGHT_PANEL_MIN_WIDTH,
      Math.min(
        RIGHT_PANEL_MAX_WIDTH,
        Math.floor(layoutWidth * RIGHT_PANEL_MAX_FRACTION),
        layoutWidth - CHAT_COLUMN_MIN_WIDTH - RESIZE_HANDLE_WIDTH,
      ),
    );
  }, [layoutWidth]);
  const { width: panelWidth, resizing, handlers: resizeHandlers } = useResizableWidth({
    storageKey: RIGHT_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: RIGHT_PANEL_DEFAULT_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    maxWidth: panelMaxWidth,
    edge: "left",
  });

  const onModelChange = async (ref: ModelRef) => {
    if (!threadId || switchingModel || state.running) return;
    const requestId = ++modelRequestRef.current;
    setSwitchingModel(true);
    setModelError("");
    try {
      await setThreadModel(threadId, ref);
    } catch (error) {
      if (requestId === modelRequestRef.current) {
        setModelError(error instanceof Error ? error.message : "切换模型失败");
      }
    } finally {
      if (requestId === modelRequestRef.current) setSwitchingModel(false);
    }
  };

  useEffect(() => {
    modelRequestRef.current += 1;
    setSwitchingModel(false);
    setModelError("");
  }, [threadId]);

  useEffect(() => {
    const element = layoutRef.current;
    if (!element) return;
    const measure = () => setLayoutWidth(Math.floor(element.getBoundingClientRect().width));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!canManageThread && panelOpen) setPanelOpen(false);
  }, [canManageThread, panelOpen, setPanelOpen]);

  useEffect(() => {
    if (!canManageThread && shareDialogOpen) setShareDialogOpen(false);
  }, [canManageThread, setShareDialogOpen, shareDialogOpen]);

  useEffect(() => {
    const element = composerOverlayRef.current;
    if (!canInteract || !element) {
      setComposerHeight(0);
      return;
    }
    const measure = () => setComposerHeight(Math.ceil(element.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [canInteract, threadId]);

  if (!threadId) return null;

  return (
    <div ref={layoutRef} className="flex h-full min-h-0 min-w-0 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="hidden shrink-0 bg-white md:block dark:bg-zinc-950">
          <div className="flex min-h-13 items-center gap-2 px-3 py-2 sm:px-4">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">{thread?.title ?? "会话"}</div>
              {project && (
                <div className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-400">
                  <FolderGit2 className="h-3 w-3 shrink-0" />
                  <span className="truncate">{project.name}</span>
                </div>
              )}
            </div>
            {canManageThread && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="分享会话"
                  title="分享会话"
                  className="text-muted-foreground"
                  onClick={() => setShareDialogOpen(true)}
                >
                  <Share2 className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="打开工作区面板"
                  title="打开工作区面板"
                  aria-controls="thread-workspace-panel"
                  aria-expanded={panelOpen}
                  className="text-muted-foreground"
                  onClick={() => setPanelOpen(true)}
                >
                  <PanelRightOpen className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        </header>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 bg-gradient-to-b from-white to-transparent dark:from-zinc-950"
          />
          <ChatView threadId={threadId} bottomInset={canInteract ? composerHeight : 0} />
          {canInteract && (
            <div ref={composerOverlayRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-2">
              <div
                aria-hidden="true"
                className="absolute inset-y-0 left-0 right-[var(--app-scrollbar-width)] bg-white dark:bg-zinc-950"
              />
              <div className="relative mx-auto max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
                <div className="pointer-events-auto">
                  <Composer
                    key={threadId}
                    draftKey={threadComposerDraftKey(threadId)}
                    threadId={threadId}
                    projectId={thread?.projectId}
                    contextUsage={state.contextUsage}
                    running={state.running}
                    onSend={(text, attachments) => sendMessage(threadId, text, attachments)}
                    onInterrupt={() => interrupt(threadId)}
                    onCompact={() => compactContext(threadId)}
                    footerError={canManageThread ? modelError : undefined}
                    footerControls={canManageThread ? (
                      <>
                        <ModelPicker value={effectiveModel} onChange={(ref) => void onModelChange(ref)} disabled={state.running || switchingModel} />
                        <ReasoningEffortPicker
                          compact
                          model={effectiveModel}
                          disabled={state.running || switchingModel}
                          onChange={(reasoningEffort) => {
                            if (effectiveModel) void onModelChange({ ...effectiveModel, reasoningEffort });
                          }}
                        />
                      </>
                    ) : undefined}
                  />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {canManageThread && (
        <>
          {panelOpen && (
            <RightPanelResizeHandle
              handlers={resizeHandlers}
              width={panelWidth}
              minWidth={RIGHT_PANEL_MIN_WIDTH}
              maxWidth={panelMaxWidth}
              resizing={resizing}
            />
          )}
          <div
            id="thread-workspace-panel"
            aria-hidden={!panelOpen}
            className={panelOpen
              ? `fixed inset-0 z-40 w-full min-w-0 overflow-hidden bg-white lg:static lg:z-auto lg:my-[10px] lg:mr-[10px] lg:w-[var(--right-panel-width)] lg:shrink-0 lg:rounded-lg lg:border lg:border-zinc-200 lg:shadow-md lg:shadow-zinc-950/10 dark:bg-zinc-950 lg:dark:border-zinc-800 lg:dark:shadow-black/30 ${resizing ? "[&_iframe]:pointer-events-none" : ""}`
              : "hidden"}
            style={{ "--right-panel-width": `${panelWidth}px` } as CSSProperties}
          >
            <RightPanel threadId={threadId} projectId={thread?.projectId} onClose={() => setPanelOpen(false)} />
          </div>
        </>
      )}
      {thread && canManageThread && (
        <ThreadShareDialog
          threadId={thread.id}
          threadTitle={thread.title}
          open={shareDialogOpen}
          onOpenChange={setShareDialogOpen}
        />
      )}
    </div>
  );
}
