import { useEffect, useState } from "react";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import type {
  ConnectorConfig,
  ConnectorConnectionState,
  ConnectorPlatform,
  ModelRef,
} from "@cca/protocol";
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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

const statusLabels: Record<ConnectorConnectionState, string> = {
  disabled: "已停用",
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重连中",
  error: "错误",
};

function emptyConnector(projectId = "", model?: ModelRef): ConnectorConfig {
  return {
    id: "",
    name: "",
    platform: "qq",
    enabled: true,
    appId: "",
    appSecret: "",
    projectId,
    model: model ?? { providerId: "", modelId: "" },
    allowedUserIds: [],
  };
}

function modelValue(model: ModelRef): string {
  return `${model.providerId}\u0000${model.modelId}`;
}

function modelFromValue(value: string, current: ModelRef): ModelRef {
  const [providerId = "", modelId = ""] = value.split("\u0000");
  return { providerId, modelId, reasoningEffort: current.reasoningEffort };
}

export function ConnectorsSettings() {
  const settings = useApp((state) => state.settings);
  const projects = useApp((state) => state.projects);
  const models = useApp((state) => state.models);
  const statuses = useApp((state) => state.connectorStatuses);
  const updateSettings = useApp((state) => state.updateSettings);
  const refreshConnectorStatuses = useApp((state) => state.refreshConnectorStatuses);
  const [editing, setEditing] = useState<ConnectorConfig | null>(null);
  const [allowedUsers, setAllowedUsers] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<ConnectorConfig | null>(null);

  useEffect(() => {
    void refreshConnectorStatuses().catch(() => {});
  }, [refreshConnectorStatuses]);

  if (!settings) return null;

  const openEdit = (connector?: ConnectorConfig) => {
    const fallbackModel = settings.defaultModel ?? models[0]?.ref;
    const target = connector ?? emptyConnector(projects[0]?.id, fallbackModel);
    setEditing({
      ...target,
      id: target.id || `connector-${Date.now()}`,
      model: { ...target.model },
      allowedUserIds: target.allowedUserIds ? [...target.allowedUserIds] : [],
    });
    setAllowedUsers(target.allowedUserIds?.join("\n") ?? "");
    setError("");
  };

  const saveConnectors = async (connectors: ConnectorConfig[]) => {
    setSaving(true);
    setError("");
    try {
      await updateSettings({ ...settings, connectors });
      setEditing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存连接器失败");
    } finally {
      setSaving(false);
    }
  };

  const submit = () => {
    if (!editing) return;
    if (
      !editing.name.trim() ||
      !editing.appId.trim() ||
      !editing.appSecret.trim() ||
      !editing.projectId ||
      !editing.model.providerId ||
      !editing.model.modelId
    ) {
      setError("名称、App ID（AK）、App Secret（AS）、工作区和模型必填");
      return;
    }
    const next: ConnectorConfig = {
      ...editing,
      name: editing.name.trim(),
      appId: editing.appId.trim(),
      appSecret: editing.appSecret.trim(),
      allowedUserIds: [...new Set(allowedUsers.split(/[\n,]/).map((value) => value.trim()).filter(Boolean))],
    };
    const exists = settings.connectors.some((connector) => connector.id === next.id);
    void saveConnectors(
      exists
        ? settings.connectors.map((connector) => connector.id === next.id ? next : connector)
        : [...settings.connectors, next],
    );
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">消息连接器</h2>
          <p className="text-xs text-zinc-500">接入 QQ 或飞书，每个外部聊天使用独立 Agent 会话</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="outline"
            aria-label="刷新连接器状态"
            onClick={() => void refreshConnectorStatuses()}
          >
            <RefreshCw className="h-3.5 w-3.5" /> 刷新
          </Button>
          <Button size="sm" onClick={() => openEdit()}>
            <Plus className="h-3.5 w-3.5" /> 添加
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {settings.connectors.length === 0 && (
          <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            还没有配置消息连接器
          </div>
        )}
        {settings.connectors.map((connector) => {
          const status = statuses.find((candidate) => candidate.id === connector.id);
          const state = status?.state ?? (connector.enabled ? "connecting" : "disabled");
          const project = projects.find((candidate) => candidate.id === connector.projectId);
          const model = models.find((candidate) => modelValue(candidate.ref) === modelValue(connector.model));
          return (
            <div key={connector.id} className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {connector.name}
                    <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                      {connector.platform === "qq" ? "QQ" : "飞书"}
                    </Badge>
                  </div>
                  <div className="truncate text-xs text-zinc-500">
                    {project?.name ?? "工作区不存在"} · {model?.label ?? connector.model.modelId}
                  </div>
                </div>
                <Badge
                  variant={state === "error" ? "destructive" : "secondary"}
                  className="h-5 px-1.5 text-[10px] font-normal"
                  title={status?.message}
                >
                  {statusLabels[state]}
                </Badge>
                <Button variant="ghost" size="icon" onClick={() => openEdit(connector)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`删除 ${connector.name}`}
                  onClick={() => setDeleting(connector)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-red-500" />
                </Button>
              </div>
              {status?.message && (
                <div className={`mt-2 text-xs ${state === "error" ? "text-red-500" : "text-zinc-500"}`}>
                  {status.message}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <FormDialog
        open={editing !== null}
        onClose={() => !saving && setEditing(null)}
        title={settings.connectors.some((connector) => connector.id === editing?.id) ? "编辑连接器" : "添加连接器"}
      >
        {editing && (
          <>
            <LabeledField label="启用">
              <div className="flex h-9 items-center justify-between rounded-md border border-zinc-200 px-3 dark:border-zinc-800">
                <span className="text-sm">保存后建立平台长连接</span>
                <Switch
                  checked={editing.enabled}
                  onCheckedChange={(enabled) => setEditing({ ...editing, enabled })}
                />
              </div>
            </LabeledField>
            <LabeledField label="平台">
              <Select
                value={editing.platform}
                onValueChange={(platform) => setEditing({ ...editing, platform: platform as ConnectorPlatform })}
              >
                <SelectTrigger className="w-full" aria-label="平台"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="qq">QQ</SelectItem>
                  <SelectItem value="feishu">飞书</SelectItem>
                </SelectContent>
              </Select>
            </LabeledField>
            <LabeledField label="名称">
              <Input
                value={editing.name}
                onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                placeholder={editing.platform === "qq" ? "例如 QQ 助手" : "例如 飞书研发助手"}
              />
            </LabeledField>
            <LabeledField label="App ID（AK）">
              <Input
                value={editing.appId}
                onChange={(event) => setEditing({ ...editing, appId: event.target.value })}
                autoComplete="off"
              />
            </LabeledField>
            <LabeledField label="App Secret（AS）">
              <Input
                type="password"
                value={editing.appSecret}
                onChange={(event) => setEditing({ ...editing, appSecret: event.target.value })}
                autoComplete="new-password"
              />
            </LabeledField>
            <LabeledField label="工作区">
              <Select
                value={editing.projectId}
                onValueChange={(projectId) => setEditing({ ...editing, projectId })}
              >
                <SelectTrigger className="w-full" aria-label="工作区"><SelectValue placeholder="选择工作区" /></SelectTrigger>
                <SelectContent>
                  {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </LabeledField>
            <LabeledField label="模型">
              <Select
                value={modelValue(editing.model)}
                onValueChange={(value) => setEditing({ ...editing, model: modelFromValue(value, editing.model) })}
              >
                <SelectTrigger className="w-full" aria-label="模型"><SelectValue placeholder="选择服务模型" /></SelectTrigger>
                <SelectContent>
                  {models.map((model) => (
                    <SelectItem key={modelValue(model.ref)} value={modelValue(model.ref)}>{model.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledField>
            <LabeledField label="允许的用户 ID（可选，每行一个）">
              <Textarea
                rows={4}
                className="mono"
                value={allowedUsers}
                onChange={(event) => setAllowedUsers(event.target.value)}
                placeholder="留空表示允许所有平台用户"
              />
            </LabeledField>
            {error && <div className="mb-2 text-xs text-red-500" aria-live="polite">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={saving} onClick={() => setEditing(null)}>取消</Button>
              <Button disabled={saving} onClick={submit}>{saving ? "保存中" : "保存"}</Button>
            </div>
          </>
        )}
      </FormDialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="删除连接器？"
        description={deleting ? `将停止并删除“${deleting.name}”，已有会话会保留。` : ""}
        confirmLabel="删除"
        destructive
        onConfirm={() => {
          if (deleting) void saveConnectors(settings.connectors.filter((connector) => connector.id !== deleting.id));
          setDeleting(null);
        }}
      />
    </div>
  );
}
