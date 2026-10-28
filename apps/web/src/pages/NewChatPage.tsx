import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftRight, Folder, FolderOpen, FolderPlus, Loader2, PanelRightOpen } from "lucide-react";
import { useNavigate } from "react-router-dom";
import {
  DEFAULT_AGENT_RUNTIME,
  DEFAULT_MODEL_PROVIDER_ID,
  type AgentMode,
  type AgentRuntime,
  type ModelRef,
  type PermissionMode,
  type TurnAttachment,
} from "@cca/protocol";
import { useApp } from "../lib/store";
import { NEW_CHAT_DRAFT_KEY } from "../lib/composerDrafts";
import { BrandLogo } from "../components/BrandLogo";
import { Composer } from "../components/Composer";
import { ComposerModelPicker } from "../components/ComposerModelPicker";
import { ComposerPermissionPicker } from "../components/ComposerPermissionPicker";
import { ComposerRuntimePicker } from "../components/ComposerRuntimePicker";
import { RightPanel } from "../components/RightPanel";
import { RightPanelResizeHandle } from "../components/RightPanelResizeHandle";
import { useResizableWidth } from "../hooks/useResizableWidth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const RIGHT_PANEL_WIDTH_STORAGE_KEY = "cloud-coding-agent:right-panel-width";
const RIGHT_PANEL_DEFAULT_WIDTH = 540;
const RIGHT_PANEL_MIN_WIDTH = 320;
const RIGHT_PANEL_MAX_WIDTH = 1400;
const RIGHT_PANEL_MAX_FRACTION = 0.7;
const CHAT_COLUMN_MIN_WIDTH = 400;
const RESIZE_HANDLE_WIDTH = 8;

export function NewChatPage() {
  const projects = useApp((s) => s.projects);
  const settings = useApp((s) => s.settings);
  const models = useApp((s) => s.models);
  const localMode = useApp((s) => s.localMode);
  const createWorkspace = useApp((s) => s.createWorkspace);
  const selectLocalFolder = useApp((s) => s.selectLocalFolder);
  const createThread = useApp((s) => s.createThread);
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState<string>("");
  const [model, setModel] = useState<ModelRef | undefined>(undefined);
  const [runtime, setRuntime] = useState<AgentRuntime>(DEFAULT_AGENT_RUNTIME);
  const [agentMode, setAgentMode] = useState<AgentMode>("standard");
  const [permissionMode, setPermissionMode] = useState<PermissionMode>("full");
  const [creating, setCreating] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [selectedFolder, setSelectedFolder] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");
  const [runtimeError, setRuntimeError] = useState("");

  const effectiveProjectId = projectId || projects[0]?.id || "";
  const effectiveModel = model ?? settings?.defaultModel;
  const effectiveProjectName =
    projects.find((project) => project.id === effectiveProjectId)?.name ?? "";
  const hasWorkspace = Boolean(effectiveProjectId);
  const panelOpen = useApp((s) => s.workspacePanelOpen);
  const setPanelOpen = useApp((s) => s.setWorkspacePanelOpen);
  const panelPlacement = useApp((s) => s.panelPlacement);
  const setPanelPlacement = useApp((s) => s.setPanelPlacement);
  const [layoutWidth, setLayoutWidth] = useState(0);
  const layoutRef = useRef<HTMLDivElement>(null);
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
    if (!hasWorkspace && panelOpen) setPanelOpen(false);
  }, [hasWorkspace, panelOpen, setPanelOpen]);

  /** DSH 只能使用应用侧配置的自定义模型服务，切到 DSH 时自动落到第一个可用模型。 */
  const selectRuntime = (next: AgentRuntime) => {
    setRuntime(next);
    setRuntimeError("");
    if (next !== "dsh") return;
    const current = effectiveModel;
    if (current && current.providerId !== DEFAULT_MODEL_PROVIDER_ID) return;
    const fallback = models.find((option) => {
      if (option.ref.providerId === DEFAULT_MODEL_PROVIDER_ID) return false;
      const provider = settings?.providers.find(
        (candidate) => candidate.id === option.ref.providerId,
      );
      return provider?.type !== "azure";
    });
    if (!fallback) {
      setRuntimeError("DSH 引擎需要先在「设置 → 模型服务」中配置自定义模型");
      return;
    }
    setModel({
      ...fallback.ref,
      reasoningEffort: fallback.defaultReasoningEffort,
    });
  };

  const selectModel = (next: ModelRef) => {
    setModel(next);
    setRuntimeError("");
  };

  const dshModelIssue = (): string => {
    if (runtime !== "dsh") return "";
    if (!effectiveModel) return "DSH 引擎需要选择已配置的模型服务";
    if (effectiveModel.providerId === DEFAULT_MODEL_PROVIDER_ID) {
      return "DSH 引擎不能使用 Codex 内置模型，请选择自定义模型服务";
    }
    const provider = settings?.providers.find((candidate) => candidate.id === effectiveModel.providerId);
    if (!provider) return "DSH 引擎使用的模型提供方不存在";
    if (provider.type === "azure") {
      return "DSH 引擎暂不支持 Azure 模型提供方，请改用 OpenAI 兼容或 Anthropic 提供方";
    }
    return "";
  };

  const onSend = async (text: string, attachments: TurnAttachment[]) => {
    if (!effectiveProjectId || creating) return;
    const issue = dshModelIssue();
    if (issue) {
      setRuntimeError(issue);
      return;
    }
    setRuntimeError("");
    setCreating(true);
    try {
      const thread = await createThread(
        effectiveProjectId,
        effectiveModel,
        agentMode,
        permissionMode,
        { text, attachments },
        runtime,
      );
      navigate(`/thread/${thread.id}`);
    } catch (error) {
      setRuntimeError(error instanceof Error ? error.message : "创建会话失败");
    } finally {
      setCreating(false);
    }
  };

  const onCreateWorkspace = async () => {
    const name = workspaceName.trim() || (localMode ? selectedFolder.split(/[\\/]/).filter(Boolean).at(-1) || "本地工作区" : "");
    if (creating || !name) return;
    setCreating(true);
    setWorkspaceError("");
    try {
      const workspace = await createWorkspace(name, localMode ? selectedFolder || undefined : undefined);
      setProjectId(workspace.id);
      setWorkspaceName("");
      setSelectedFolder("");
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "创建工作区失败");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div ref={layoutRef} className="flex h-full min-h-0 min-w-0 overflow-hidden">
      <div className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${hasWorkspace && panelPlacement === "left" ? "lg:order-last" : ""}`}>
        {hasWorkspace && (
          <header className="hidden shrink-0 bg-background md:block">
            <div className="flex min-h-[56px] items-center justify-end gap-2 px-5 pb-2.5 pt-2.5">
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
            </div>
          </header>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto px-4">
          <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center py-10">
            <div className="mb-6 text-center">
              <BrandLogo className="mx-auto mb-3 h-10 w-10" />
              <h1 className="text-xl font-semibold">
                {projects.length > 0 && effectiveProjectName
                  ? `我们应该在${effectiveProjectName}中做些什么？`
                  : "今天要处理什么？"}
              </h1>
            </div>
            {projects.length === 0 ? (
              <form
                className="mx-auto w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950"
                onSubmit={(event) => {
                  event.preventDefault();
                  void onCreateWorkspace();
                }}
              >
                <div className="mb-4 text-center">
                  <FolderPlus className="mx-auto mb-2 h-5 w-5 text-zinc-500" />
                  <h2 className="text-sm font-medium">创建你的第一个工作区</h2>
                  <p className="mt-1 text-xs text-zinc-500">工作区文件会与其他用户完全隔离</p>
                </div>
                <Input
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                  placeholder="工作区名称"
                  aria-label="工作区名称"
                  maxLength={80}
                  autoFocus
                  disabled={creating}
                />
                {localMode && (
                  <div className="mt-3 flex flex-col gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full justify-start"
                      disabled={creating}
                      onClick={() => void selectLocalFolder().then((folder) => {
                        if (!folder) return;
                        setSelectedFolder(folder);
                        if (!workspaceName.trim()) setWorkspaceName(folder.split(/[\\/]/).filter(Boolean).at(-1) ?? "本地工作区");
                      }).catch((error) => setWorkspaceError(error instanceof Error ? error.message : "无法打开文件夹选择器"))}
                    >
                      <FolderOpen className="h-4 w-4" />
                      {selectedFolder ? "重新选择本地文件夹" : "选择本地文件夹"}
                    </Button>
                    {selectedFolder && (
                      <div className="truncate rounded-md bg-zinc-100 px-2.5 py-2 text-xs text-zinc-500 dark:bg-zinc-900" title={selectedFolder}>
                        {selectedFolder}
                      </div>
                    )}
                  </div>
                )}
                {workspaceError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{workspaceError}</p>}
                <Button className="mt-3 w-full" type="submit" disabled={creating || (!workspaceName.trim() && !selectedFolder)}>
                  {creating && <Loader2 className="animate-spin" />}
                  创建工作区
                </Button>
              </form>
            ) : (
              <>
                <div className="mb-2 flex items-center gap-2 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-900">
                  <Folder className="h-4 w-4 shrink-0 text-zinc-500" />
                  <Select
                    disabled={creating}
                    value={effectiveProjectId}
                    onValueChange={setProjectId}
                  >
                    <SelectTrigger
                      className="h-8 w-full min-w-0 border-0 bg-transparent p-0 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
                      aria-label="选择工作区"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Composer
                  draftKey={NEW_CHAT_DRAFT_KEY}
                  projectId={effectiveProjectId}
                  running={creating}
                  onSend={(text, attachments) => onSend(text, attachments)}
                  autoFocus
                  placeholder="描述你的编码任务，@ 引用文件，/ 使用技能"
                  footerError={runtimeError || undefined}
                  leadingControls={
                    <>
                      <ComposerRuntimePicker
                        value={runtime}
                        onChange={selectRuntime}
                        disabled={creating}
                      />
                      <ComposerPermissionPicker
                        value={permissionMode}
                        onChange={setPermissionMode}
                        disabled={creating}
                      />
                    </>
                  }
                  footerControls={
                    <ComposerModelPicker
                      value={effectiveModel}
                      onChange={selectModel}
                      disabled={creating}
                      agentMode={agentMode}
                      onAgentModeChange={setAgentMode}
                    />
                  }
                />
              </>
            )}
          </div>
        </div>
      </div>
      {hasWorkspace && (
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
              key={effectiveProjectId}
              threadId={`workspace-${effectiveProjectId}`}
              projectId={effectiveProjectId}
              panelVisible={panelOpen}
              onClose={() => setPanelOpen(false)}
            />
          </div>
        </>
      )}
    </div>
  );
}
