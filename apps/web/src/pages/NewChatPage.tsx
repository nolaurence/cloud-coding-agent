import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ModelRef } from "@cca/protocol";
import { useApp } from "../lib/store";
import { Composer } from "../components/Composer";
import { ModelPicker } from "../components/ModelPicker";
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

  const onSend = async (text: string, attachments: { path: string; displayName?: string }[]) => {
    if (!effectiveProjectId || creating) return;
    setCreating(true);
    try {
      const thread = await createThread(effectiveProjectId, model ?? settings?.defaultModel);
      await sendMessage(thread.id, text, attachments);
      navigate(`/thread/${thread.id}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div className="w-full max-w-2xl">
        <h1 className="mb-1 text-center text-2xl font-semibold">Cloud Coding Agent</h1>
        <p className="mb-6 text-center text-sm text-zinc-500">
          选择一个项目目录,描述任务,Agent 会在云端完成编码
        </p>
        {projects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
            请先在左侧边栏添加一个项目目录
          </div>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-2">
              <Select
                className="w-auto"
                value={effectiveProjectId}
                onChange={(e) => setProjectId(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
              <ModelPicker value={model} onChange={setModel} />
            </div>
            <Composer
              projectId={effectiveProjectId}
              running={creating}
              onSend={(text, attachments) => void onSend(text, attachments)}
              autoFocus
              placeholder="描述你的编码任务… 输入 @ 引用文件,/ 选择技能"
            />
          </>
        )}
      </div>
    </div>
  );
}
