import { useEffect, useRef, useState } from "react";
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
  const [composerHeight, setComposerHeight] = useState(0);
  const composerOverlayRef = useRef<HTMLDivElement>(null);
  const modelRequestRef = useRef(0);
  const effectiveModel = thread?.model ?? settings?.defaultModel;

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
    const element = composerOverlayRef.current;
    if (!element) return;
    const measure = () => setComposerHeight(Math.ceil(element.getBoundingClientRect().height));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  if (!threadId) return null;

  return (
    <div className="flex h-full flex-col">
      <header className="hidden shrink-0 border-b border-zinc-200 bg-white md:block dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex min-h-13 flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{thread?.title ?? "会话"}</div>
            {project && (
              <div className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-400" title={project.path}>
                <FolderGit2 className="h-3 w-3 shrink-0" />
                <span className="truncate">{project.name}</span>
              </div>
            )}
          </div>
        </div>
      </header>
      <div className="relative min-h-0 flex-1">
        <ChatView threadId={threadId} bottomInset={composerHeight} />
        <div
          ref={composerOverlayRef}
          className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-2"
        >
          <div className="mx-auto max-w-3xl px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
            <div className="pointer-events-auto">
              <Composer
                key={threadId}
                threadId={threadId}
                projectId={thread?.projectId}
                running={state.running}
                onSend={(text, attachments) => sendMessage(threadId, text, attachments)}
                onInterrupt={() => interrupt(threadId)}
                footerError={modelError}
                footerControls={
                  <>
                    <ModelPicker
                      value={effectiveModel}
                      onChange={(ref) => void onModelChange(ref)}
                      disabled={state.running || switchingModel}
                    />
                    <ReasoningEffortPicker
                      compact
                      model={effectiveModel}
                      disabled={state.running || switchingModel}
                      onChange={(reasoningEffort) => {
                        if (effectiveModel) {
                          void onModelChange({ ...effectiveModel, reasoningEffort });
                        }
                      }}
                    />
                  </>
                }
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
