import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { McpServerConfig } from "@cca/protocol";
import { useApp } from "../../lib/store";
import { Button, Dialog, Field, Input, Select, Switch, Textarea } from "../../components/ui/primitives";

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
  const updateSettings = useApp((s) => s.updateSettings);
  const [editing, setEditing] = useState<McpServerConfig | null>(null);
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [toolsText, setToolsText] = useState("*");
  const [error, setError] = useState("");

  if (!settings) return null;

  const save = (mcpServers: McpServerConfig[]) => {
    void updateSettings({ ...settings, mcpServers });
  };

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
    const exists = settings.mcpServers.some((s) => s.id === next.id);
    save(exists ? settings.mcpServers.map((s) => (s.id === next.id ? next : s)) : [...settings.mcpServers, next]);
    setEditing(null);
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
              onChange={(v) => save(settings.mcpServers.map((x) => (x.id === s.id ? { ...x, enabled: v } : x)))}
            />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">{s.name}</div>
              <div className="mono truncate text-xs text-zinc-500">
                {s.type === "http" ? s.url : `${s.command} ${(s.args ?? []).join(" ")}`}
              </div>
            </div>
            <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800">
              {s.type === "http" ? "HTTP" : "本地"}
            </span>
            <Button variant="ghost" size="icon" onClick={() => openEdit(s)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => {
                if (confirm(`删除 ${s.name}?`)) save(settings.mcpServers.filter((x) => x.id !== s.id));
              }}
            >
              <Trash2 className="h-3.5 w-3.5 text-red-500" />
            </Button>
          </div>
        ))}
      </div>

      <Dialog open={editing !== null} onClose={() => setEditing(null)} title={editing?.name ? "编辑 MCP 服务器" : "添加 MCP 服务器"}>
        {editing && (
          <>
            <Field label="名称">
              <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="例如 filesystem" />
            </Field>
            <Field label="类型">
              <Select value={editing.type} onChange={(e) => setEditing({ ...editing, type: e.target.value as "local" | "http" })}>
                <option value="local">本地(stdio 子进程)</option>
                <option value="http">远程(HTTP/SSE)</option>
              </Select>
            </Field>
            {editing.type === "local" ? (
              <>
                <Field label="启动命令">
                  <Input value={editing.command ?? ""} onChange={(e) => setEditing({ ...editing, command: e.target.value })} placeholder="npx" />
                </Field>
                <Field label="参数(空格分隔)">
                  <Input className="mono" value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem /data" />
                </Field>
                <Field label={"环境变量(每行 KEY=VALUE)"}>
                  <Textarea rows={3} className="mono" value={envText} onChange={(e) => setEnvText(e.target.value)} />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL">
                  <Input className="mono" value={editing.url ?? ""} onChange={(e) => setEditing({ ...editing, url: e.target.value })} placeholder="https://example.com/mcp" />
                </Field>
                <Field label={"请求头(每行 KEY=VALUE)"}>
                  <Textarea rows={3} className="mono" value={headersText} onChange={(e) => setHeadersText(e.target.value)} placeholder="Authorization=Bearer xxx" />
                </Field>
              </>
            )}
            <Field label={"允许的工具(逗号分隔,* 表示全部)"}>
              <Input className="mono" value={toolsText} onChange={(e) => setToolsText(e.target.value)} placeholder="*" />
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
