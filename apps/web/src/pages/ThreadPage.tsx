import { useState } from "react";
import { FolderGit2 } from "lucide-react";
import { useParams } from "react-router-dom";
import type { ModelRef } from "@cca/protocol";
import { useApp, useThreadState } from "../lib/store";
import { ChatView } from "../components/ChatView";
import { Composer } from "../components/Composer";
import { ModelPicker } from "../components/ModelPicker";
import { ReasoningEffortPicker } from "../components/ReasoningEffortPicker";

export function ThreadPage() {
  const { threadId } = useParams<{ threadId: string }>();
  const threads = useApp((s) => s.threads);
  const projects = useApp((s) => s.projects);
  const settings = useApp((s) => s.settings);
  const sendMessage = useApp((s) => s.sendMessage);
  const interrupt = useApp((s) => s.interrupt);
  const setThreadModel = useApp((s) => s.setThreadModel);
  const state = useThreadState(threadId);
  const thread = threads.find((t) => t.id === threadId);
  const project = projects.find((candidate) => candidate.id === thread?.projectId);
  const [switchingModel, setSwitchingModel] = useState(false);
  const [modelError, setModelError] = useState("");
  const effectiveModel = thread?.model ?? settings?.defaultModel;

  if (!threadId) return null;

  const onModelChange = async (ref: ModelRef) => {
    if (switchingModel || state.running) return;
    setSwitchingModel(true);
    setModelError("");
    try {
      await setThreadModel(threadId, ref);
    } catch (error) {
      setModelError(error instanceof Error ? error.message : "切换模型失败");
    } finally {
      setSwitchingModel(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex min-h-13 flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
          <div className="min-w-0 flex-1 basis-full sm:basis-auto">
            <div className="truncate text-sm font-medium">{thread?.title ?? "会话"}</div>
            {project && (
              <div className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-400" title={project.path}>
                <FolderGit2 className="h-3 w-3 shrink-0" />
                <span className="truncate">{project.name}</span>
              </div>
            )}
          </div>
          <div className="flex max-w-full flex-wrap items-center gap-2">
            <ModelPicker
              value={effectiveModel}
              onChange={(ref) => void onModelChange(ref)}
              disabled={state.running || switchingModel}
              direction="down"
            />
            <ReasoningEffortPicker
              model={effectiveModel}
              disabled={state.running || switchingModel}
              onChange={(reasoningEffort) => {
                if (effectiveModel) void onModelChange({ ...effectiveModel, reasoningEffort });
              }}
            />
          </div>
          {modelError && (
            <div className="basis-full text-xs text-red-600 dark:text-red-400" role="alert">
              {modelError}
            </div>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <ChatView threadId={threadId} />
      </div>
      <div className="shrink-0 border-t border-zinc-200 bg-white px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mx-auto max-w-3xl">
          <Composer
            threadId={threadId}
            projectId={thread?.projectId}
            running={state.running}
            onSend={(text, attachments) => sendMessage(threadId, text, attachments)}
            onInterrupt={() => interrupt(threadId)}
          />
        </div>
      </div>
    </div>
  );
}
