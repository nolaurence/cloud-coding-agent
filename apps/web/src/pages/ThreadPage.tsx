import { useParams } from "react-router-dom";
import type { ModelRef } from "@cca/protocol";
import { useApp, useThreadState } from "../lib/store";
import { ChatView } from "../components/ChatView";
import { Composer } from "../components/Composer";
import { ModelPicker } from "../components/ModelPicker";

export function ThreadPage() {
  const { threadId } = useParams<{ threadId: string }>();
  const threads = useApp((s) => s.threads);
  const sendMessage = useApp((s) => s.sendMessage);
  const interrupt = useApp((s) => s.interrupt);
  const setThreadModel = useApp((s) => s.setThreadModel);
  const state = useThreadState(threadId);
  const thread = threads.find((t) => t.id === threadId);

  if (!threadId) return null;

  const onModelChange = (ref: ModelRef) => {
    void setThreadModel(threadId, ref);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{thread?.title ?? "会话"}</div>
          <div className="truncate text-[11px] text-zinc-400">{thread?.id}</div>
        </div>
        <ModelPicker value={thread?.model} onChange={onModelChange} />
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
