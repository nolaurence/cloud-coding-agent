import { useState } from "react";
import { FolderPlus, Loader2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { AgentMode, ModelRef, TurnAttachment } from "@cca/protocol";
import { useApp } from "../lib/store";
import { NEW_CHAT_DRAFT_KEY } from "../lib/composerDrafts";
import { BrandLogo } from "../components/BrandLogo";
import { Composer } from "../components/Composer";
import { ModelPicker } from "../components/ModelPicker";
import { ReasoningEffortPicker } from "../components/ReasoningEffortPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function NewChatPage() {
  const projects = useApp((s) => s.projects);
  const settings = useApp((s) => s.settings);
  const createWorkspace = useApp((s) => s.createWorkspace);
  const createThread = useApp((s) => s.createThread);
  const sendMessage = useApp((s) => s.sendMessage);
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState<string>("");
  const [model, setModel] = useState<ModelRef | undefined>(undefined);
  const [agentMode, setAgentMode] = useState<AgentMode>("standard");
  const [creating, setCreating] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspaceError, setWorkspaceError] = useState("");

  const effectiveProjectId = projectId || projects[0]?.id || "";
  const effectiveModel = model ?? settings?.defaultModel;

  const onSend = async (text: string, attachments: TurnAttachment[]) => {
    if (!effectiveProjectId || creating) return;
    setCreating(true);
    try {
      const thread = await createThread(effectiveProjectId, effectiveModel, agentMode);
      navigate(`/thread/${thread.id}`);
      await sendMessage(thread.id, text, attachments);
    } finally {
      setCreating(false);
    }
  };

  const onCreateWorkspace = async () => {
    if (creating || !workspaceName.trim()) return;
    setCreating(true);
    setWorkspaceError("");
    try {
      const workspace = await createWorkspace(workspaceName);
      setProjectId(workspace.id);
      setWorkspaceName("");
    } catch (error) {
      setWorkspaceError(error instanceof Error ? error.message : "创建工作区失败");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center py-10">
        <div className="mb-6 text-center">
          <BrandLogo className="mx-auto mb-3 h-10 w-10" />
          <h1 className="text-xl font-semibold">今天要处理什么？</h1>
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
            {workspaceError && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{workspaceError}</p>}
            <Button className="mt-3 w-full" type="submit" disabled={creating || !workspaceName.trim()}>
              {creating && <Loader2 className="animate-spin" />}
              创建工作区
            </Button>
          </form>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
              <Select
                disabled={creating}
                value={effectiveProjectId}
                onValueChange={setProjectId}
              >
                <SelectTrigger className="w-full sm:w-44" aria-label="选择工作区">
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
              placeholder="输入编码任务"
              footerControls={
                <>
                  <ModelPicker value={effectiveModel} onChange={setModel} disabled={creating} />
                  <ReasoningEffortPicker
                    compact
                    model={effectiveModel}
                    disabled={creating}
                    agentMode={agentMode}
                    onAgentModeChange={setAgentMode}
                    onChange={(reasoningEffort) => {
                      if (effectiveModel) setModel({ ...effectiveModel, reasoningEffort });
                    }}
                  />
                </>
              }
            />
          </>
        )}
      </div>
    </div>
  );
}
