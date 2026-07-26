import { useState } from "react";
import { Bot, FolderGit2 } from "lucide-react";
import { useNavigate } from "react-router-dom";
import type { ModelRef } from "@cca/protocol";
import { useApp } from "../lib/store";
import { Composer } from "../components/Composer";
import { ModelPicker } from "../components/ModelPicker";
import { ReasoningEffortPicker } from "../components/ReasoningEffortPicker";
import { Select } from "../components/ui/primitives";

export function NewChatPage() {
  const projects = useApp((s) => s.projects);
  const settings = useApp((s) => s.settings);
  const createThread = useApp((s) => s.createThread);
  const sendMessage = useApp((s) => s.sendMessage);
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState<string>("");
  const [model, setModel] = useState<ModelRef | undefined>(undefined);
  const [creating, setCreating] = useState(false);

  const effectiveProjectId = projectId || projects[0]?.id || "";
  const effectiveModel = model ?? settings?.defaultModel;

  const onSend = async (text: string, attachments: { path: string; displayName?: string }[]) => {
    if (!effectiveProjectId || creating) return;
    setCreating(true);
    try {
      const thread = await createThread(effectiveProjectId, effectiveModel);
      navigate(`/thread/${thread.id}`);
      await sendMessage(thread.id, text, attachments);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4">
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center py-10">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
            <Bot className="h-5 w-5" />
          </div>
          <h1 className="text-xl font-semibold">今天要处理什么？</h1>
        </div>
        {projects.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500">
            <FolderGit2 className="h-4 w-4" />
            请先添加项目目录
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-center gap-2">
              <Select
                aria-label="选择项目"
                className="w-full sm:w-44"
                disabled={creating}
                value={effectiveProjectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <Composer
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
