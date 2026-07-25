import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { ModelProviderConfig, ProviderType, WireApi } from "@cca/protocol";
import { useApp } from "../../lib/store";
import { Button, Dialog, Field, Input, Select, Textarea } from "../../components/ui/primitives";

const emptyProvider = (): ModelProviderConfig => ({
  id: "",
  name: "",
  type: "openai",
  baseUrl: "",
  apiKey: "",
  wireApi: "completions",
  models: [],
});

export function ProvidersSettings() {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const [editing, setEditing] = useState<ModelProviderConfig | null>(null);
  const [modelsText, setModelsText] = useState("");
  const [error, setError] = useState("");

  if (!settings) return null;

  const save = (providers: ModelProviderConfig[]) => {
    void updateSettings({ ...settings, providers });
  };

  const openEdit = (p?: ModelProviderConfig) => {
    const target = p ?? emptyProvider();
    setEditing({ ...target, id: target.id || `p-${Date.now()}` });
    setModelsText(target.models.map((m) => (m.name ? `${m.id} | ${m.name}` : m.id)).join("\n"));
    setError("");
  };

  const submit = () => {
    if (!editing) return;
    if (!editing.name.trim() || !editing.baseUrl.trim()) {
      setError("名称和 Base URL 必填");
      return;
    }
    const models = modelsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [id, name] = line.split("|").map((s) => s.trim());
        return { id: id!, name: name || undefined };
      });
    if (models.length === 0) {
      setError("至少填写一个模型");
      return;
    }
    const next = { ...editing, models, apiKey: editing.apiKey || undefined };
    const exists = settings.providers.some((p) => p.id === next.id);
    save(exists ? settings.providers.map((p) => (p.id === next.id ? next : p)) : [...settings.providers, next]);
    setEditing(null);
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">模型服务</h2>
          <p className="text-xs text-zinc-500">
            支持 OpenAI 兼容协议(Chat Completions)和 OpenAI Responses 协议,以及 Azure / Anthropic
          </p>
        </div>
        <Button size="sm" onClick={() => openEdit()}>
          <Plus className="h-3.5 w-3.5" /> 添加
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        {settings.providers.length === 0 && (
          <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            还没有配置模型服务
          </div>
        )}
        {settings.providers.map((p) => (
          <div key={p.id} className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div className="flex items-center gap-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{p.name}</div>
                <div className="mono truncate text-xs text-zinc-500">{p.baseUrl}</div>
              </div>
              <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800">
                {p.type === "openai" ? (p.wireApi === "responses" ? "openai-responses" : "openai") : p.type}
              </span>
              <Button variant="ghost" size="icon" onClick={() => openEdit(p)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  if (confirm(`删除 ${p.name}?`)) save(settings.providers.filter((x) => x.id !== p.id));
                }}
              >
                <Trash2 className="h-3.5 w-3.5 text-red-500" />
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {p.models.map((m) => (
                <span key={m.id} className="mono rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] dark:bg-zinc-800">
                  {m.name ?? m.id}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing?.name ? "编辑模型服务" : "添加模型服务"}>
        {editing && (
          <>
            <Field label="名称">
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="例如 DeepSeek" />
            </Field>
            <Field label="类型">
              <Select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value as ProviderType })}>
                <option value="openai">OpenAI 兼容</option>
                <option value="azure">Azure OpenAI</option>
                <option value="anthropic">Anthropic</option>
              </Select>
            </Field>
            <Field label="Base URL">
              <Input
                value={editing.baseUrl}
                onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </Field>
            {editing.type !== "anthropic" && (
              <Field label="协议 (Wire API)">
                <Select value={editing.wireApi} onChange={(e) => setEditing({ ...editing, wireApi: e.target.value as WireApi })}>
                  <option value="completions">openai(Chat Completions)</option>
                  <option value="responses">openai-responses(Responses API)</option>
                </Select>
              </Field>
            )}
            <Field label="API Key">
              <Input
                type="password"
                value={editing.apiKey ?? ""}
                onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
                placeholder="sk-..."
              />
            </Field>
            {editing.type === "azure" && (
              <Field label="Azure API Version">
                <Input
                  value={editing.azureApiVersion ?? "2024-10-21"}
                  onChange={(e) => setEditing({ ...editing, azureApiVersion: e.target.value })}
                />
              </Field>
            )}
            <Field label={"模型列表(每行一个,格式:模型id 或 模型id | 显示名)"}>
              <Textarea
                rows={5}
                className="mono"
                value={modelsText}
                onChange={(e) => setModelsText(e.target.value)}
                placeholder={"gpt-4o | GPT-4o\ndeepseek-chat"}
              />
            </Field>
            {error && <div className="mb-2 text-xs text-red-500">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>
                取消
              </Button>
              <Button onClick={submit}>保存</Button>
            </div>
          </>
        )}
      </Dialog>
    </div>
  );
}
