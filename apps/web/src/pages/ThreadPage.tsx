import { type CSSProperties, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, ArrowLeftRight, FolderGit2, ListChecks, PanelRightOpen, Share2 } from "lucide-react";
import { useParams } from "react-router-dom";
import { resolveThreadModel, resolveThreadModelProviderId } from "@cca/protocol";
import type { AgentMode, ModelRef, PermissionMode } from "@cca/protocol";
import { useApp, useThreadState } from "../lib/store";
import { threadComposerDraftKey } from "../lib/composerDrafts";
import { ChatView } from "../components/ChatView";
import { Composer } from "../components/Composer";
import { ComposerModelPicker } from "../components/ComposerModelPicker";
import { ComposerPermissionPicker } from "../components/ComposerPermissionPicker";
import { RuntimeStatsBar } from "../components/RuntimeStatsBar";
import { RightPanel } from "../components/RightPanel";
import { RightPanelResizeHandle } from "../components/RightPanelResizeHandle";
import { ThreadShareDialog } from "../components/ThreadShareDialog";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { SessionOverview } from "../components/SessionOverview";
import type { ImagePreviewTarget } from "../lib/imagePreview";

const DshTrajectory = lazy(() => import("../components/DshTrajectory"));
type ThreadView = "chat" | "trajectory";

function readThreadView(threadId: string | undefined): ThreadView {
  try { return localStorage.getItem(`cca-thread-view:${threadId}`) === "trajectory" ? "trajectory" : "chat"; }
  catch { return "chat"; }
}

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
  const setThreadAgentMode = useApp((s) => s.setThreadAgentMode);
  const setThreadPermissionMode = useApp((s) => s.setThreadPermissionMode);
  const respondPermission = useApp((s) => s.respondPermission);
  const panelOpen = useApp((s) => s.workspacePanelOpen);
  const setPanelOpen = useApp((s) => s.setWorkspacePanelOpen);
  const panelPlacement = useApp((s) => s.panelPlacement);
  const setPanelPlacement = useApp((s) => s.setPanelPlacement);
  const shareDialogOpen = useApp((s) => s.shareDialogOpen);
  const setShareDialogOpen = useApp((s) => s.setShareDialogOpen);
  const state = useThreadState(threadId);
  const thread = threads.find((t) => t.id === threadId);
  const [viewState, setViewState] = useState(() => ({ threadId, view: readThreadView(threadId) }));
  const view: ThreadView = thread?.runtime === "dsh"
    ? viewState.threadId === threadId ? viewState.view : readThreadView(threadId)
    : "chat";
  const selectView = (next: ThreadView) => {
    setViewState({ threadId, view: next });
    setViewingSubagentId(null);
    try { localStorage.setItem(`cca-thread-view:${threadId}`, next); }
    catch { /* Keep the selection for this visit if browser storage is unavailable. */ }
  };
  const project = projects.find((candidate) => candidate.id === thread?.projectId);
  const canManageThread = thread?.access === "owner";
  const legacySession = Boolean(thread && thread.runtime !== "codex" && thread.runtime !== "dsh");
  const canInteract = !legacySession && (canManageThread || thread?.access === "collaborate");
  const [switchingModel, setSwitchingModel] = useState(false);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [switchingPermission, setSwitchingPermission] = useState(false);
  const [modelError, setModelError] = useState("");
  const [viewingSubagentId, setViewingSubagentId] = useState<string | null>(null);
  const [imageToOpen, setImageToOpen] = useState<ImagePreviewTarget | null>(null);
  const [overviewOpen, setOverviewOpen] = useState(() => {
    try { return localStorage.getItem("cca:session-overview") !== "0"; } catch { return true; }
  });
  const [overviewMobileOpen, setOverviewMobileOpen] = useState(false);
  const [wideLayout, setWideLayout] = useState(() => window.matchMedia("(min-width: 1280px)").matches);
  const [revealTurn, setRevealTurn] = useState<{ turnId: string; requestId: number } | null>(null);
  const [tabToOpen, setTabToOpen] = useState<{ id: "diff"; requestId: number } | null>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const layoutRef = useRef<HTMLDivElement>(null);
  const composerOverlayRef = useRef<HTMLDivElement>(null);
  const modelRequestRef = useRef(0);
  const modelProviderId = resolveThreadModelProviderId(thread, settings?.defaultModel);
  const effectiveModel = resolveThreadModel(thread, settings?.defaultModel);
  const agentMode = thread?.agentMode ?? "standard";
  const permissionMode = thread?.permissionMode ?? "full";
  const showRuntimeStats = Boolean(
    thread?.runtime === "dsh" && (state.runtimeStats || state.contextUsage),
  );
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
    edge: panelPlacement === "right" ? "left" : "right",
  });

  const onModelChange = async (ref: ModelRef) => {
    if (!threadId || switchingModel || switchingMode || state.running) return;
    if (ref.providerId !== modelProviderId) {
      setModelError("会话创建后不能切换模型提供方,请新建会话使用该模型");
      return;
    }
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

  const closeOverview = () => {
    if (!wideLayout) { setOverviewMobileOpen(false); return; }
    setOverviewOpen(false);
    try { localStorage.setItem("cca:session-overview", "0"); } catch {}
  };
  const toggleOverview = () => {
    if (wideLayout) {
      const next = !overviewOpen || panelOpen;
      setOverviewOpen(next);
      try { localStorage.setItem("cca:session-overview", next ? "1" : "0"); } catch {}
    } else setOverviewMobileOpen(true);
    setPanelOpen(false);
  };
  const jumpToTurn = (turnId: string) => {
    selectView("chat");
    setViewingSubagentId(null);
    setOverviewMobileOpen(false);
    setRevealTurn((previous) => ({ turnId, requestId: (previous?.requestId ?? 0) + 1 }));
  };
  const openOverviewChanges = () => {
    setOverviewMobileOpen(false);
    setTabToOpen((previous) => ({ id: "diff", requestId: (previous?.requestId ?? 0) + 1 }));
    setPanelOpen(true);
  };

  const onPermissionModeChange = async (mode: PermissionMode) => {
    if (!threadId || switchingPermission || switchingMode || switchingModel || state.running || mode === permissionMode) {
      return;
    }
    setSwitchingPermission(true);
    setModelError("");
    try {
      await setThreadPermissionMode(threadId, mode);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "切换权限模式失败");
    } finally {
      setSwitchingPermission(false);
    }
  };

  const onPermissionDecision = async (decision: "accept" | "decline") => {
    const request = state.pendingPermission;
    if (!threadId || !request) return;
    setModelError("");
    try {
      await respondPermission(threadId, request.requestId, decision);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "响应权限请求失败");
    }
  };

  const onAgentModeChange = async (mode: AgentMode) => {
    if (!threadId || switchingMode || switchingModel || state.running || mode === agentMode) {
      return false;
    }
    setSwitchingMode(true);
    setModelError("");
    try {
      await setThreadAgentMode(threadId, mode);
      return true;
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "切换会话模式失败");
      return false;
    } finally {
      setSwitchingMode(false);
    }
  };

  useEffect(() => {
    modelRequestRef.current += 1;
    setSwitchingModel(false);
    setSwitchingMode(false);
    setSwitchingPermission(false);
    setModelError("");
    setViewingSubagentId(null);
    setImageToOpen(null);
    setRevealTurn(null);
    setTabToOpen(null);
    setOverviewMobileOpen(false);
  }, [threadId]);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)");
    const onChange = () => { setWideLayout(media.matches); setOverviewMobileOpen(false); };
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

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
  }, [canInteract, threadId, viewingSubagentId]);

  if (!threadId) return null;

  return (
    <div ref={layoutRef} className="flex h-full min-h-0 min-w-0 overflow-hidden">
      <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${panelPlacement === "left" ? "lg:order-last" : ""}`}>
        {canManageThread && <div className="flex shrink-0 justify-end border-b border-line-2 px-3 py-1 md:hidden">
          <Button type="button" variant="ghost" size="sm" aria-label="打开会话概览" onClick={toggleOverview}><ListChecks className="size-3.5" />会话概览</Button>
        </div>}
        <header className="hidden shrink-0 bg-background md:block">
          <div className="flex min-h-[56px] items-center gap-2 px-5 pb-2.5 pt-2.5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] leading-5 text-label-1">{thread?.title ?? "会话"}</div>
              {project && (
                <div className="mt-0.5 flex items-center gap-1 text-[12px] leading-[18px] text-label-3">
                  <FolderGit2 className="h-3 w-3 shrink-0" strokeWidth={1.8} />
                  <span className="truncate">{project.name}</span>
                </div>
              )}
            </div>
            {canManageThread && (
              <>
                <Button type="button" variant="ghost" size="icon" aria-label="切换会话概览" title="会话概览"
                  aria-expanded={wideLayout ? overviewOpen && !panelOpen : overviewMobileOpen} className="text-muted-foreground" onClick={toggleOverview}>
                  <ListChecks className="h-4 w-4" />
                </Button>
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
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="互换对话区与工作区位置"
                  title={panelPlacement === "right" ? "将工作区移到左侧" : "将工作区移到右侧"}
                  className="text-muted-foreground"
                  onClick={() => setPanelPlacement(panelPlacement === "right" ? "left" : "right")}
                >
                  <ArrowLeftRight className="h-4 w-4" />
                </Button>
              </>
            )}
          </div>
        </header>
        {legacySession && <p className="border-b px-4 py-2 text-sm text-muted-foreground">旧 Copilot 会话仅保留历史浏览，请新建 Codex 或 DSH 会话继续工作。</p>}
        {thread?.runtime === "dsh" && (
          <div role="tablist" aria-label="会话视图" className="flex shrink-0 gap-4 border-b px-4">
            {([['chat', '对话'], ['trajectory', '轨迹']] as const).map(([id, label]) => (
              <button
                key={id}
                id={`thread-${id}-tab`}
                type="button"
                role="tab"
                aria-selected={view === id}
                aria-controls="thread-view-panel"
                className={`border-b-2 px-1 py-2 text-[13px] transition-colors ${view === id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                onClick={() => selectView(id)}
              >{label}</button>
            ))}
          </div>
        )}
        <div id="thread-view-panel" role={thread?.runtime === "dsh" ? "tabpanel" : undefined} aria-labelledby={thread?.runtime === "dsh" ? `thread-${view}-tab` : undefined} className="relative min-h-0 flex-1 overflow-hidden">
          {view === "trajectory" ? (
            <Suspense fallback={<div role="status" className="flex h-full items-center justify-center text-sm text-muted-foreground">正在加载轨迹…</div>}>
              <DshTrajectory key={threadId} threadId={threadId} composerHeight={canInteract ? composerHeight : 0} />
            </Suspense>
          ) : (
            <ChatView
              threadId={threadId}
              revealTurn={revealTurn}
              bottomInset={canInteract ? composerHeight : 0}
              selectedSubagentId={viewingSubagentId}
              onSubagentViewChange={setViewingSubagentId}
              onOpenImage={canManageThread ? (image) => {
                setImageToOpen({ ...image });
                setPanelOpen(true);
              } : undefined}
            />
          )}
          {canInteract && (
            <div ref={composerOverlayRef} className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-2">
              <div
                aria-hidden="true"
                className="absolute inset-y-0 left-0 right-[var(--app-scrollbar-width)] bg-background [mask-image:linear-gradient(to_bottom,transparent_0,black_36px)]"
              />
              <div className="relative mx-auto w-full max-w-[min(100%,calc(clamp(680px,64%,920px)+64px))] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
                <div className="pointer-events-auto">
                  {state.pendingPermission && (
                    <div className="mx-auto mb-2 w-full rounded-[16px] border border-amber-200 bg-amber-50 p-3 text-amber-950 shadow-sm dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-50">
                      <div className="flex items-start gap-2">
                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                        <div className="min-w-0 flex-1">
                          <div className="text-[13px] font-medium">Codex 请求权限</div>
                          <div className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-300">
                            {state.pendingPermission.kind === "command"
                              ? "执行命令"
                              : state.pendingPermission.kind === "file"
                                ? "修改工作区外的文件"
                                : "访问额外权限"}
                          </div>
                          {state.pendingPermission.command && (
                            <pre className="mt-2 max-h-28 overflow-auto rounded-md bg-amber-100/80 px-2 py-1.5 text-[11px] leading-4 whitespace-pre-wrap break-all dark:bg-amber-900/40">
                              {state.pendingPermission.command}
                            </pre>
                          )}
                          {state.pendingPermission.reason && (
                            <p className="mt-1.5 text-[11px] leading-4 text-amber-800/90 dark:text-amber-200/90">
                              {state.pendingPermission.reason}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 flex justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void onPermissionDecision("decline")}
                        >
                          拒绝
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          onClick={() => void onPermissionDecision("accept")}
                        >
                          允许
                        </Button>
                      </div>
                    </div>
                  )}
                  <div className={viewingSubagentId ? "hidden" : undefined}>
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
                      statusBar={
                        showRuntimeStats ? (
                          <RuntimeStatsBar
                            stats={state.runtimeStats}
                            contextUsage={state.contextUsage}
                          />
                        ) : undefined
                      }
                      leadingControls={canManageThread ? (
                        <ComposerPermissionPicker
                          value={permissionMode}
                          onChange={onPermissionModeChange}
                          disabled={state.running || switchingMode || switchingModel}
                          updating={switchingPermission}
                        />
                      ) : undefined}
                      footerControls={canManageThread ? (
                        <ComposerModelPicker
                          value={effectiveModel}
                          onChange={(ref) => void onModelChange(ref)}
                          disabled={state.running || switchingMode || switchingPermission}
                          updating={switchingModel}
                          lockedProviderId={modelProviderId}
                          agentMode={agentMode}
                          onAgentModeChange={onAgentModeChange}
                        />
                      ) : undefined}
                    />
                  </div>
                  {viewingSubagentId && (
                    <div className="flex min-h-12 items-center justify-between gap-3 rounded-[16px] border-[0.5px] border-line-3 bg-elevated px-4 py-2 text-[13px] leading-5 text-label-2">
                      <span className="min-w-0">
                        子代理详情为只读
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="shrink-0"
                        onClick={() => setViewingSubagentId(null)}
                      >
                        <ArrowLeft className="h-3.5 w-3.5" />
                        返回主会话
                      </Button>
                    </div>
                  )}
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
              placement={panelPlacement}
            />
          )}
          <div
            id="thread-workspace-panel"
            aria-hidden={!panelOpen}
            className={panelOpen
              ? `fixed inset-0 z-40 w-full min-w-0 overflow-hidden bg-white lg:static lg:z-auto ${panelPlacement === "right" ? "lg:order-last lg:border-l" : "lg:order-first lg:border-r"} lg:w-[var(--right-panel-width)] lg:shrink-0 lg:border-zinc-200 dark:bg-zinc-950 lg:dark:border-zinc-800 ${resizing ? "[&_iframe]:pointer-events-none" : ""}`
              : "hidden"}
            style={{ "--right-panel-width": `${panelWidth}px` } as CSSProperties}
          >
            <RightPanel
              key={threadId}
              threadId={threadId}
              projectId={thread?.projectId}
              panelVisible={panelOpen}
              tabToOpen={tabToOpen}
              imageToOpen={imageToOpen?.threadId === threadId ? imageToOpen : null}
              onClose={() => setPanelOpen(false)}
            />
          </div>
        </>
      )}
      {canManageThread && wideLayout && overviewOpen && !panelOpen && (
        <div className="order-last h-full w-[320px] shrink-0">
          <SessionOverview key={threadId} threadId={threadId} onClose={closeOverview} onJump={jumpToTurn} onOpenChanges={openOverviewChanges} />
        </div>
      )}
      {canManageThread && !wideLayout && <Sheet open={overviewMobileOpen && !panelOpen} onOpenChange={setOverviewMobileOpen}>
        <SheetContent side="right" showCloseButton={false} className="gap-0 p-0 data-[side=right]:w-[min(92vw,340px)] sm:max-w-none">
          <SheetTitle className="sr-only">会话概览</SheetTitle>
          <SessionOverview key={threadId} threadId={threadId} onClose={closeOverview} onJump={jumpToTurn} onOpenChanges={openOverviewChanges} />
        </SheetContent>
      </Sheet>}
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
