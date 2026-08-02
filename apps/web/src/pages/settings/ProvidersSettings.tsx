import { useState } from "react";
import { Loader2, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { ModelEntry, ModelProviderConfig, ProviderType, WireApi } from "@cca/protocol";
import { useApp } from "../../lib/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { LabeledField } from "@/components/ui/labeled-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
  const discoverProviderModels = useApp((s) => s.discoverProviderModels);
  const [editing, setEditing] = useState<ModelProviderConfig | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [deleting, setDeleting] = useState<ModelProviderConfig | null>(null);

  if (!settings) return null;

  const save = (providers: ModelProviderConfig[]) => {
    void updateSettings({ ...settings, providers });
  };

  const openEdit = (p?: ModelProviderConfig) => {
    const target = p ?? emptyProvider();
    setEditing({
      ...target,
      id: target.id || `p-${Date.now()}`,
      wireApi: target.wireApi ?? "completions",
      models: target.models.length
        ? target.models.map((model) => ({ ...model }))
        : [{ id: "", name: "" }],
    });
    setError("");
    setNotice("");
  };

  const discoverModels = async () => {
    if (!editing || discovering) return;
    if (!editing.baseUrl.trim()) {
      setError("请先填写 Base URL");
      return;
    }

    setDiscovering(true);
    setError("");
    setNotice("");
    try {
      const models = await discoverProviderModels({
        type: editing.type,
        baseUrl: editing.baseUrl,
        apiKey: editing.apiKey,
        azureApiVersion: editing.azureApiVersion,
      });
      setEditing((current) =>
        current?.id === editing.id ? { ...current, models } : current,
      );
      setNotice(`已获取 ${models.length} 个模型`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "获取模型失败");
    } finally {
      setDiscovering(false);
    }
  };

  const updateModel = (index: number, field: "id" | "name", value: string) => {
    setEditing((current) => current ? {
      ...current,
      models: current.models.map((model, modelIndex) =>
        modelIndex === index ? { ...model, [field]: value } : model,
      ),
    } : current);
  };

  const updateModelContextWindow = (index: number, value: string) => {
    setEditing((current) => current ? {
      ...current,
      models: current.models.map((model, modelIndex) =>
        modelIndex === index
          ? { ...model, contextWindowTokens: value === "" ? undefined : Number(value) }
          : model,
      ),
    } : current);
  };

  const addModel = () => {
    setEditing((current) => current ? {
      ...current,
      models: [...current.models, { id: "", name: "" }],
    } : current);
  };

  const removeModel = (index: number) => {
    setEditing((current) => current ? {
      ...current,
      models: current.models.filter((_, modelIndex) => modelIndex !== index),
    } : current);
  };

  const submit = () => {
    if (!editing) return;
    if (!editing.name.trim() || !editing.baseUrl.trim()) {
      setError("名称和 Base URL 必填");
      return;
    }
    const populatedModels = editing.models.filter(
      (model) =>
        model.id.trim() || model.name?.trim() || model.contextWindowTokens !== undefined,
    );
    if (populatedModels.some((model) => !model.id.trim())) {
      setError("请填写每个模型的模型 ID");
      return;
    }
    if (
      populatedModels.some(
        (model) =>
          model.contextWindowTokens !== undefined &&
          (!Number.isSafeInteger(model.contextWindowTokens) || model.contextWindowTokens <= 0),
      )
    ) {
      setError("上下文 Token 必须是正整数");
      return;
    }
    const models: ModelEntry[] = populatedModels.map((model) => ({
      ...model,
      id: model.id.trim(),
      name: model.name?.trim() || undefined,
    }));
    if (models.length === 0) {
      setError("至少填写一个模型");
      return;
    }
    if (new Set(models.map((model) => model.id)).size !== models.length) {
      setError("模型 ID 不能重复");
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
              <Badge variant="secondary" className="h-5 px-1.5 font-mono text-[10px] font-normal">
                {p.type === "openai" ? (p.wireApi === "responses" ? "openai-responses" : "openai") : p.type}
              </Badge>
              <Button variant="ghost" size="icon" onClick={() => openEdit(p)}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`删除 ${p.name}`}
                onClick={() => setDeleting(p)}
              >
                <Trash2 className="h-3.5 w-3.5 text-red-500" />
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-1">
              {p.models.map((m) => (
                <Badge key={m.id} variant="secondary" className="h-5 px-1.5 font-mono text-[10px] font-normal">
                  {m.name ?? m.id}
                </Badge>
              ))}
            </div>
          </div>
        ))}
      </div>

      <FormDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.name ? "编辑模型服务" : "添加模型服务"}
        wide
      >
        {editing && (
          <>
            <LabeledField label="名称">
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="例如 DeepSeek" />
            </LabeledField>
            <LabeledField label="类型">
              <Select
                value={editing.type}
                onValueChange={(type) => setEditing({ ...editing, type: type as ProviderType })}
              >
                <SelectTrigger className="w-full" aria-label="类型">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="openai">OpenAI 兼容</SelectItem>
                  <SelectItem value="azure">Azure OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                </SelectContent>
              </Select>
            </LabeledField>
            <LabeledField label="Base URL">
              <Input
                value={editing.baseUrl}
                onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
                placeholder="https://api.openai.com/v1"
              />
            </LabeledField>
            {editing.type !== "anthropic" && (
              <LabeledField label="协议 (Wire API)">
                <Select
                  value={editing.wireApi ?? "completions"}
                  onValueChange={(wireApi) => setEditing({ ...editing, wireApi: wireApi as WireApi })}
                >
                  <SelectTrigger className="w-full" aria-label="协议 (Wire API)">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="completions">openai(Chat Completions)</SelectItem>
                    <SelectItem value="responses">openai-responses(Responses API)</SelectItem>
                  </SelectContent>
                </Select>
              </LabeledField>
            )}
            <LabeledField label="API Key">
              <Input
                type="password"
                value={editing.apiKey ?? ""}
                onChange={(e) => setEditing({ ...editing, apiKey: e.target.value })}
                placeholder="sk-..."
              />
            </LabeledField>
            {editing.type === "azure" && (
              <LabeledField label="Azure API Version">
                <Input
                  value={editing.azureApiVersion ?? "2024-10-21"}
                  onChange={(e) => setEditing({ ...editing, azureApiVersion: e.target.value })}
                />
              </LabeledField>
            )}
            <div className="mb-3">
              <div className="mb-2 flex min-h-7 flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-xs font-medium text-zinc-500 dark:text-zinc-400">模型列表</div>
                <div className="flex shrink-0 justify-end gap-1.5">
                  {editing.type === "openai" && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="whitespace-nowrap"
                      disabled={discovering || !editing.baseUrl.trim()}
                      onClick={() => void discoverModels()}
                    >
                      {discovering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                      {discovering ? "获取中" : "自动获取"}
                    </Button>
                  )}
                  <Button type="button" variant="outline" size="sm" onClick={addModel}>
                    <Plus className="h-3.5 w-3.5" />添加模型
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(7rem,0.65fr)_1.75rem] gap-2 px-0.5 pb-1 text-[11px] text-zinc-500 dark:text-zinc-400">
                <span>模型 ID</span>
                <span>显示名称</span>
                <span>上下文 Token</span>
                <span className="sr-only">操作</span>
              </div>
              <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                {editing.models.map((model, index) => (
                  <div key={index} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(7rem,0.65fr)_1.75rem] items-center gap-2">
                    <Input
                      className="font-mono"
                      value={model.id}
                      onChange={(event) => updateModel(index, "id", event.target.value)}
                      placeholder="gpt-4o"
                      aria-label={`第 ${index + 1} 个模型 ID`}
                    />
                    <Input
                      value={model.name ?? ""}
                      onChange={(event) => updateModel(index, "name", event.target.value)}
                      placeholder="可选"
                      aria-label={`第 ${index + 1} 个模型显示名称`}
                    />
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      value={model.contextWindowTokens ?? ""}
                      onChange={(event) => updateModelContextWindow(index, event.target.value)}
                      placeholder="258000"
                      aria-label={`第 ${index + 1} 个模型上下文 Token`}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-zinc-500 hover:text-red-500"
                      title="删除模型"
                      aria-label={`删除第 ${index + 1} 个模型`}
                      onClick={() => removeModel(index)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                ))}
                {editing.models.length === 0 && (
                  <div className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-zinc-500">
                    暂无模型，请点击“添加模型”
                  </div>
                )}
              </div>
              <p className="mt-1.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                留空时优先使用模型服务返回的上限或内置默认值。
              </p>
            </div>
            <div aria-live="polite">
              {error && <div className="mb-2 text-xs text-red-500">{error}</div>}
              {!error && notice && <div className="mb-2 text-xs text-emerald-600 dark:text-emerald-400">{notice}</div>}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>
                取消
              </Button>
              <Button disabled={discovering} onClick={submit}>保存</Button>
            </div>
          </>
        )}
      </FormDialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="删除模型服务？"
        description={deleting ? `将删除“${deleting.name}”及其模型配置。` : ""}
        confirmLabel="删除"
        destructive
        onConfirm={() => {
          if (deleting) save(settings.providers.filter((provider) => provider.id !== deleting.id));
          setDeleting(null);
        }}
      />
    </div>
  );
}
