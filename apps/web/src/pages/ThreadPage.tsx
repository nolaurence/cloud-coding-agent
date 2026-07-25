import { useState } from "react";
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
  const settings = useApp((s) => s.settings);
  const sendMessage = useApp((s) => s.sendMessage);
  const interrupt = useApp((s) => s.interrupt);
  const setThreadModel = useApp((s) => s.setThreadModel);
  const state = useThreadState(threadId);
  const thread = threads.find((t) => t.id === threadId);
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
      <header className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <div className="min-w-0 flex-1 basis-full sm:basis-auto">
          <div className="truncate text-sm font-medium">{thread?.title ?? "会话"}</div>
          <div className="truncate text-[11px] text-zinc-400">{thread?.id}</div>
        </div>
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
        {modelError && (
          <div className="basis-full text-xs text-red-600 dark:text-red-400" role="alert">
            {modelError}
          </div>
        )}
      </header>
      <div className="min-h-0 flex-1">
        <ChatView threadId={threadId} />
      </div>
      <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="mx-auto max-w-3xl">
          <Composer
            threadId={threadId}
            projectId={thread?.projectId}
            running={state.running}
            onSend={(text, attachments) => void sendMessage(threadId, text, attachments)}
            onInterrupt={() => void interrupt(threadId)}
          />
        </div>
      </div>
    </div>
  );
}
