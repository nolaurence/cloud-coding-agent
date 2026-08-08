import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { McpServerConfig } from "@cca/protocol";
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

const emptyServer = (): McpServerConfig => ({
  id: "",
  name: "",
  enabled: true,
  type: "local",
  command: "",
  args: [],
  env: {},
  url: "",
  headers: {},
  tools: ["*"],
});

function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function toKeyValueLines(obj?: Record<string, string>): string {
  return Object.entries(obj ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

export function McpSettings() {
  const settings = useApp((s) => s.settings);
  const saveMcpServer = useApp((s) => s.saveMcpServer);
  const deleteMcpServer = useApp((s) => s.deleteMcpServer);
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [toolsText, setToolsText] = useState("*");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState<McpServerConfig | null>(null);

  if (!settings) return null;


  const openEdit = (s?: McpServerConfig) => {
    const target = s ?? emptyServer();
    setEditing({ ...target, id: target.id || `mcp-${Date.now()}` });
    setArgsText((target.args ?? []).join(" "));
    setEnvText(toKeyValueLines(target.env));
    setHeadersText(toKeyValueLines(target.headers));
    setToolsText(target.tools.join(", "));
    setError("");
  };

  const submit = () => {
    if (!editing) return;
    if (!editing.name.trim()) {
      setError("名称必填");
      return;
    }
    if (editing.type === "local" && !editing.command?.trim()) {
      setError("本地服务器需要填写启动命令");
      return;
    }
    if (editing.type === "http" && !editing.url?.trim()) {
      setError("HTTP 服务器需要填写 URL");
      return;
    }
    const next: McpServerConfig = {
      ...editing,
      args: argsText.trim() ? argsText.trim().split(/\s+/) : [],
      env: parseKeyValueLines(envText),
      headers: parseKeyValueLines(headersText),
      tools: toolsText.trim() ? toolsText.split(",").map((t) => t.trim()).filter(Boolean) : ["*"],
    };
    void saveMcpServer(next).then(() => setEditing(null), (saveError) => {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    });
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">MCP 服务器</h2>
          <p className="text-xs text-zinc-500">为 Agent 接入外部工具(数据库、浏览器、第三方 API 等)</p>
        </div>
        <Button size="sm" onClick={() => openEdit()}>
          <Plus className="h-3.5 w-3.5" /> 添加
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        {settings.mcpServers.length === 0 && (
          <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            还没有配置 MCP 服务器
          </div>
        )}
        {settings.mcpServers.map((s) => (
          <div key={s.id} className="flex items-center gap-3 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <Switch
              checked={s.enabled}
              aria-label={`${s.enabled ? "停用" : "启用"} ${s.name}`}
              onCheckedChange={(enabled) => void saveMcpServer({ ...s, enabled })}
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{s.name}</div>
              <div className="mono truncate text-xs text-zinc-500">
                {s.type === "http" ? s.url : `${s.command} ${(s.args ?? []).join(" ")}`}
              </div>
            </div>
            <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
              {s.type === "http" ? "HTTP" : "本地"}
            </Badge>
            <Button variant="ghost" size="icon" onClick={() => openEdit(s)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`删除 ${s.name}`}
              onClick={() => setDeleting(s)}
            >
              <Trash2 className="h-3.5 w-3.5 text-red-500" />
            </Button>
          </div>
        ))}
      </div>

      <FormDialog open={editing !== null} onClose={() => setEditing(null)} title={editing?.name ? "编辑 MCP 服务器" : "添加 MCP 服务器"}>
        {editing && (
          <>
            <LabeledField label="名称">
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="例如 filesystem" />
            </LabeledField>
            <LabeledField label="类型">
              <Select
                value={editing.type}
                onValueChange={(type) => setEditing({ ...editing, type: type as "local" | "http" })}
              >
                <SelectTrigger className="w-full" aria-label="类型">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="local">本地(stdio 子进程)</SelectItem>
                  <SelectItem value="http">远程(HTTP/SSE)</SelectItem>
                </SelectContent>
              </Select>
            </LabeledField>
            {editing.type === "local" ? (
              <>
                <LabeledField label="启动命令">
                  <Input value={editing.command ?? ""} onChange={(e) => setEditing({ ...editing, command: e.target.value })} placeholder="npx" />
                </LabeledField>
                <LabeledField label="参数(空格分隔)">
                  <Input className="mono" value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /data" />
                </LabeledField>
                <LabeledField label="环境变量(每行 KEY=VALUE)">
                  <Textarea rows={3} className="mono" value={envText} onChange={(e) => setEnvText(e.target.value)} />
                </LabeledField>
              </>
            ) : (
              <>
                <LabeledField label="URL">
                  <Input className="mono" value={editing.url ?? ""} onChange={(e) => setEditing({ ...editing, url: e.target.value })} placeholder="https://example.com/mcp" />
                </LabeledField>
                <LabeledField label="请求头(每行 KEY=VALUE)">
                  <Textarea rows={3} className="mono" value={headersText} onChange={(e) => setHeadersText(e.target.value)} placeholder="Authorization=Bearer xxx" />
                </LabeledField>
              </>
            )}
            <LabeledField label="允许的工具(逗号分隔,* 表示全部)">
              <Input className="mono" value={toolsText} onChange={(e) => setToolsText(e.target.value)} placeholder="*" />
            </LabeledField>
            {error && <div className="mb-2 text-xs text-red-500">{error}</div>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>
                取消
              </Button>
              <Button onClick={submit}>保存</Button>
            </div>
          </>
        )}
      </FormDialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="删除 MCP 服务器？"
        description={deleting ? `将删除“${deleting.name}”的连接和工具配置。` : ""}
        confirmLabel="删除"
        destructive
        onConfirm={() => {
          if (deleting) void deleteMcpServer(deleting.id);
          setDeleting(null);
        }}
      />
    </div>
  );
}
