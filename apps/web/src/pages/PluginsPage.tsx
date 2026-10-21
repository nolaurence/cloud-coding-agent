import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import type { InstalledPlugin } from "@cca/protocol";
import { useApp } from "../lib/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

function pluginStatus(plugin: InstalledPlugin): {
  label: string;
  variant: "default" | "secondary" | "destructive";
} {
  if (!plugin.record.valid) return { label: "无效", variant: "destructive" };
  return plugin.enabled
    ? { label: "已启用", variant: "default" }
    : { label: "已停用", variant: "secondary" };
}

export function PluginsPage() {
  const listInstalledPlugins = useApp((s) => s.listInstalledPlugins);
  const installPlugin = useApp((s) => s.installPlugin);
  const uninstallPlugin = useApp((s) => s.uninstallPlugin);
  const setPluginEnabled = useApp((s) => s.setPluginEnabled);

  const [plugins, setPlugins] = useState<InstalledPlugin[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [source, setSource] = useState("");
  const [installing, setInstalling] = useState(false);
  const [installNotice, setInstallNotice] = useState("");
  const [installError, setInstallError] = useState("");
  const [busyName, setBusyName] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<InstalledPlugin | null>(null);
  const [actionError, setActionError] = useState("");

  const refresh = async () => {
    setLoading(true);
    setLoadError("");
    try {
      setPlugins(await listInstalledPlugins());
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const install = async () => {
    const trimmed = source.trim();
    if (!trimmed) return;
    setInstalling(true);
    setInstallNotice("");
    setInstallError("");
    try {
      const result = await installPlugin(trimmed);
      setInstallNotice(
        `已安装“${result.plugin.name}”，包含 ${result.skillsInstalled} 个技能` +
          (result.postInstallMessage ? `。${result.postInstallMessage}` : ""),
      );
      setSource("");
      await refresh();
    } catch (err) {
      setInstallError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  const togglePlugin = async (plugin: InstalledPlugin, enabled: boolean) => {
    setBusyName(plugin.name);
    setActionError("");
    try {
      await setPluginEnabled(plugin.name, enabled);
      setPlugins((prev) =>
        prev ? prev.map((item) => (item.name === plugin.name ? { ...item, enabled } : item)) : prev,
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyName(null);
    }
  };

  const uninstall = async (plugin: InstalledPlugin) => {
    setBusyName(plugin.name);
    setActionError("");
    try {
      await uninstallPlugin(plugin.name);
      await refresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyName(null);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Agent 插件</h2>
        <p className="mt-1 text-xs text-zinc-500">
          基于{" "}
          <a
            href="https://agent-plugins.org/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            Agent Plugins 1.0 开放标准
          </a>
          （<span className="mono">plugin.json</span> 清单 +{" "}
          <span className="mono">skills/&lt;名称&gt;/SKILL.md</span> 技能 +{" "}
          <span className="mono">mcp.json</span> MCP 服务器）的可移植插件目录，同一份插件可在
          VS Code / Cursor / GitHub Copilot / ChatGPT(Codex) / Kiro 等支持该标准的宿主中通用。
          规范详见{" "}
          <a
            href="https://agent-plugins.org/"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            [agent-plugins.org]
          </a>
          。
        </p>
      </div>

      <div className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
        <div className="text-sm font-medium">安装插件</div>
        <p className="mt-1 text-xs text-zinc-500">
          填写服务端上插件目录的绝对路径（目录内含 <span className="mono">plugin.json</span>）
        </p>
        <div className="mt-2 flex gap-2">
          <Input
            className="mono flex-1"
            value={source}
            placeholder="/path/to/my-plugin"
            onChange={(e) => setSource(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && source.trim() && !installing) void install();
            }}
          />
          <Button onClick={() => void install()} disabled={!source.trim() || installing}>
            {installing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            安装
          </Button>
        </div>
        {installError && <div className="mt-2 text-xs text-red-500">{installError}</div>}
        {!installError && installNotice && (
          <div className="mt-2 text-xs text-emerald-600 dark:text-emerald-400" role="status">
            {installNotice}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">已安装插件</h3>
        <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          重新扫描
        </Button>
      </div>

      {actionError && <div className="text-xs text-red-500">{actionError}</div>}

      {loading && !plugins && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-zinc-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          加载中…
        </div>
      )}
      {loadError && <div className="text-xs text-red-500">{loadError}</div>}

      {plugins && plugins.length === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
          把符合 Agent Plugins 标准的插件目录放到服务端后安装
        </div>
      )}

      <div className="flex flex-col gap-3">
        {plugins?.map((plugin) => {
          const status = pluginStatus(plugin);
          return (
            <div
              key={plugin.name}
              className="rounded-lg border border-zinc-200 dark:border-zinc-800"
            >
              <div className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{plugin.name}</span>
                    {plugin.version && (
                      <Badge variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
                        v{plugin.version}
                      </Badge>
                    )}
                    <Badge variant={status.variant} className="h-5 px-1.5 text-[10px] font-normal">
                      {status.label}
                    </Badge>
                  </div>
                  {plugin.description && (
                    <div className="mt-1 text-xs text-zinc-500">{plugin.description}</div>
                  )}
                  <div className="mono mt-1 truncate text-xs text-zinc-400">{plugin.path}</div>
                </div>
                <Switch
                  checked={plugin.enabled}
                  disabled={!plugin.record.valid || busyName === plugin.name}
                  aria-label={`${plugin.enabled ? "停用" : "启用"} ${plugin.name}`}
                  onCheckedChange={(enabled) => void togglePlugin(plugin, enabled)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`卸载 ${plugin.name}`}
                  disabled={busyName === plugin.name}
                  onClick={() => setDeleting(plugin)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-red-500" />
                </Button>
              </div>

              {(plugin.record.skills.length > 0 ||
                plugin.record.mcpServers.length > 0 ||
                plugin.record.warnings.length > 0 ||
                plugin.record.errors.length > 0) && (
                <div className="space-y-2 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
                  {plugin.record.skills.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-zinc-500">技能</div>
                      <div className="mt-1 flex flex-col gap-1">
                        {plugin.record.skills.map((skill) => (
                          <div key={skill.id} className="text-xs">
                            <span
                              className={`mono font-medium ${skill.valid ? "" : "text-red-500"}`}
                            >
                              {skill.name || skill.id}
                            </span>
                            {skill.description && (
                              <span
                                className={`ml-2 ${skill.valid ? "text-zinc-500" : "text-red-500"}`}
                              >
                                {skill.description}
                              </span>
                            )}
                            {!skill.valid && skill.error && (
                              <div className="text-red-500">{skill.error}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {plugin.record.mcpServers.length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-zinc-500">MCP 服务器</div>
                      <div className="mt-1 flex flex-col gap-1">
                        {plugin.record.mcpServers.map((server) => (
                          <div key={server.name} className="text-xs">
                            <span
                              className={`mono font-medium ${server.valid ? "" : "text-red-500"}`}
                            >
                              {server.name}
                            </span>
                            <Badge
                              variant="secondary"
                              className="ml-2 h-4 px-1.5 text-[10px] font-normal"
                            >
                              {server.transport}
                            </Badge>
                            <span
                              className={`mono ml-2 ${server.valid ? "text-zinc-500" : "text-red-500"}`}
                            >
                              {server.transport === "stdio"
                                ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ")
                                : server.url}
                            </span>
                            {!server.valid && server.error && (
                              <div className="text-red-500">{server.error}</div>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {plugin.record.warnings.map((warning, index) => (
                    <div key={`warning-${index}`} className="text-xs text-amber-600 dark:text-amber-400">
                      {warning}
                    </div>
                  ))}
                  {plugin.record.errors.map((error, index) => (
                    <div key={`error-${index}`} className="text-xs text-red-500">
                      {error}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="卸载插件？"
        description={deleting ? `将从服务端移除插件“${deleting.name}”（${deleting.path}）。` : ""}
        confirmLabel="卸载"
        destructive
        onConfirm={() => {
          if (deleting) void uninstall(deleting);
          setDeleting(null);
        }}
      />
    </div>
  );
}
