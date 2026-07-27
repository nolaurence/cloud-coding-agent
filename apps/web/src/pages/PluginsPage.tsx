import { useCallback, useEffect, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Loader2,
  Package,
  PackageOpen,
  Plus,
  RefreshCw,
  Store,
  Trash2,
} from "lucide-react";
import type { InstalledPlugin, MarketplacePlugin, PluginMarketplace } from "@cca/protocol";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

export function PluginsPage() {
  const listPluginMarketplaces = useApp((s) => s.listPluginMarketplaces);
  const addPluginMarketplace = useApp((s) => s.addPluginMarketplace);
  const removePluginMarketplace = useApp((s) => s.removePluginMarketplace);
  const browsePluginMarketplace = useApp((s) => s.browsePluginMarketplace);
  const listInstalledPlugins = useApp((s) => s.listInstalledPlugins);
  const installPlugin = useApp((s) => s.installPlugin);
  const uninstallPlugin = useApp((s) => s.uninstallPlugin);
  const setPluginEnabled = useApp((s) => s.setPluginEnabled);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [marketplaces, setMarketplaces] = useState<PluginMarketplace[]>([]);
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<Record<string, MarketplacePlugin[]>>({});
  const [catalogLoading, setCatalogLoading] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [notice, setNotice] = useState("");
  const [newSource, setNewSource] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<{ name: string; force: boolean } | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [m, p] = await Promise.all([listPluginMarketplaces(), listInstalledPlugins()]);
      setMarketplaces(m);
      setInstalled(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [listPluginMarketplaces, listInstalledPlugins]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const refreshInstalled = async () => {
    try {
      setInstalled(await listInstalledPlugins());
    } catch {
      // 忽略,下一次操作会重试
    }
  };

  const toggleMarketplace = async (name: string) => {
    if (expanded === name) {
      setExpanded(null);
      return;
    }
    setExpanded(name);
    if (catalog[name]) return;
    setCatalogLoading(name);
    try {
      const plugins = await browsePluginMarketplace(name);
      setCatalog((prev) => ({ ...prev, [name]: plugins }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "加载市场插件失败");
    } finally {
      setCatalogLoading(null);
    }
  };

  const withPending = async (key: string, fn: () => Promise<void>) => {
    setPending((prev) => ({ ...prev, [key]: true }));
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setPending((prev) => ({ ...prev, [key]: false }));
    }
  };

  const installSpec = (plugin: MarketplacePlugin, marketplace: string) =>
    withPending(`install:${marketplace}:${plugin.name}`, async () => {
      const result = await installPlugin(`${plugin.name}@${marketplace}`);
      await refreshInstalled();
      const messages = [
        result.skillsInstalled > 0 ? `已安装 ${result.skillsInstalled} 个技能` : "",
        result.postInstallMessage ?? "",
        result.deprecationWarning ?? "",
      ].filter(Boolean);
      if (messages.length > 0) setNotice(messages.join("。"));
    });

  const uninstall = (plugin: InstalledPlugin) =>
    withPending(`uninstall:${plugin.name}`, async () => {
      await uninstallPlugin(
        plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name,
        plugin.directSourceId,
      );
      await refreshInstalled();
    });

  const toggleEnabled = (plugin: InstalledPlugin, enabled: boolean) =>
    withPending(`toggle:${plugin.name}`, async () => {
      await setPluginEnabled(
        plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name,
        enabled,
      );
      await refreshInstalled();
    });

  const addMarketplace = () =>
    withPending("marketplace:add", async () => {
      const source = newSource.trim();
      if (!source) return;
      setAdding(true);
      try {
        await addPluginMarketplace(source);
        setNewSource("");
        await refresh();
      } finally {
        setAdding(false);
      }
    });

  const removeMarketplace = (name: string, force: boolean) =>
    withPending(`marketplace:remove:${name}`, async () => {
      const result = await removePluginMarketplace(name, force);
      if (!result.removed) {
        setRemoving({ name, force: true });
        return;
      }
      setRemoving(null);
      if (expanded === name) setExpanded(null);
      await refresh();
    });

  const installedKeys = new Set(
    installed.map((p) => (p.marketplace ? `${p.name}@${p.marketplace}` : p.name)),
  );

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">插件市场</h2>
          <p className="text-xs text-zinc-500">
            浏览并安装 Copilot 插件(MCP 服务器、技能、钩子等),安装后对新会话生效
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} /> 刷新
        </Button>
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400">
          {error}
        </div>
      )}
      {notice && (
        <div className="mb-3 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs whitespace-pre-wrap text-blue-600 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-400">
          {notice}
        </div>
      )}

      <section className="mb-6">
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <PackageOpen className="h-4 w-4" /> 已安装插件
        </h3>
        <div className="flex flex-col gap-2">
          {loading && installed.length === 0 ? (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-zinc-300 p-6 text-sm text-zinc-500 dark:border-zinc-700">
              <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
            </div>
          ) : installed.length === 0 ? (
            <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
              还没有安装插件,从下方市场挑选安装
            </div>
          ) : (
            installed.map((p) => {
              const spec = p.marketplace ? `${p.name}@${p.marketplace}` : p.name;
              const busy = pending[`uninstall:${p.name}`] || pending[`toggle:${p.name}`];
              return (
                <div
                  key={spec}
                  className="flex items-center gap-3 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800"
                >
                  <Package className="h-4 w-4 shrink-0 text-blue-400" />
                  <div className="min-w-0 flex-1">
                    <div className="mono text-sm font-medium">
                      {p.name}
                      {p.version && <span className="ml-1.5 text-xs text-zinc-400">v{p.version}</span>}
                    </div>
                    <div className="truncate text-xs text-zinc-500">
                      {p.marketplace ? `来自市场 ${p.marketplace}` : "直接安装"}
                    </div>
                  </div>
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />}
                  {p.marketplace && (
                    <Switch
                      checked={p.enabled}
                      disabled={busy}
                      aria-label={`${p.enabled ? "停用" : "启用"}插件 ${p.name}`}
                      onCheckedChange={(enabled) => void toggleEnabled(p, enabled)}
                    />
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busy}
                    aria-label={`卸载插件 ${p.name}`}
                    onClick={() => void uninstall(p)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-red-500" />
                  </Button>
                </div>
              );
            })
          )}
        </div>
      </section>

      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
          <Store className="h-4 w-4" /> 插件市场
        </h3>
        <div className="flex flex-col gap-2">
          {marketplaces.map((m) => {
            const isExpanded = expanded === m.name;
            const plugins = catalog[m.name];
            return (
              <div
                key={m.name}
                className="rounded-lg border border-zinc-200 dark:border-zinc-800"
              >
                <div className="flex items-center gap-2 px-4 py-3">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => void toggleMarketplace(m.name)}
                  >
                    {isExpanded ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-zinc-400" />
                    )}
                    <span className="mono truncate text-sm font-medium">{m.name}</span>
                    {m.isDefault && (
                      <span className="shrink-0 rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                        内置
                      </span>
                    )}
                  </button>
                  {pending[`marketplace:remove:${m.name}`] && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-400" />
                  )}
                  {!m.isDefault && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`移除市场 ${m.name}`}
                      onClick={() => setRemoving({ name: m.name, force: false })}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-red-500" />
                    </Button>
                  )}
                </div>
                <div className="truncate px-4 pb-2 text-[11px] text-zinc-400">{m.source}</div>
                {isExpanded && (
                  <div className="border-t border-zinc-100 px-4 py-2 dark:border-zinc-800/60">
                    {catalogLoading === m.name ? (
                      <div className="flex items-center gap-2 py-3 text-xs text-zinc-500">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" /> 加载插件目录…
                      </div>
                    ) : !plugins || plugins.length === 0 ? (
                      <div className="py-3 text-xs text-zinc-500">该市场暂无插件</div>
                    ) : (
                      <div className="flex flex-col divide-y divide-zinc-100 dark:divide-zinc-800/60">
                        {plugins.map((plugin) => {
                          const key = `${plugin.name}@${m.name}`;
                          const isInstalled = installedKeys.has(key);
                          const busy = pending[`install:${m.name}:${plugin.name}`];
                          return (
                            <div key={plugin.name} className="flex items-center gap-3 py-2.5">
                              <div className="min-w-0 flex-1">
                                <div className="mono text-sm">{plugin.name}</div>
                                {plugin.description && (
                                  <div className="mt-0.5 line-clamp-2 text-xs text-zinc-500">
                                    {plugin.description}
                                  </div>
                                )}
                              </div>
                              {isInstalled ? (
                                <span className="shrink-0 text-xs text-zinc-400">已安装</span>
                              ) : (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() => void installSpec(plugin, m.name)}
                                >
                                  {busy ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Download className="h-3.5 w-3.5" />
                                  )}
                                  安装
                                </Button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          <div className="mt-1 flex gap-2">
            <Input
              value={newSource}
              onChange={(e) => setNewSource(e.target.value)}
              placeholder="owner/repo、Git URL 或本地路径"
              onKeyDown={(e) => {
                if (e.key === "Enter") void addMarketplace();
              }}
            />
            <Button variant="outline" onClick={() => void addMarketplace()} disabled={adding || !newSource.trim()}>
              {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              添加市场
            </Button>
          </div>
          <p className="text-[11px] text-zinc-400">
            任何包含 .github/plugin/marketplace.json(或 .claude-plugin/marketplace.json)的 Git 仓库都可以作为市场
          </p>
        </div>
      </section>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="移除插件市场？"
        description={
          removing?.force
            ? `市场“${removing.name}”下仍有已安装的插件,移除将同时卸载这些插件。`
            : `将移除市场“${removing?.name ?? ""}”,不影响已安装的插件。`
        }
        confirmLabel="移除"
        destructive
        onConfirm={() => {
          if (removing) void removeMarketplace(removing.name, removing.force);
        }}
      />
    </div>
  );
}
