import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  Check,
  Download,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  Store,
  Trash2,
} from "lucide-react";
import type { InstalledPlugin, MarketplacePlugin } from "@cca/protocol";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

type Tab = "market" | "installed";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialOf(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "").slice(0, 1).toUpperCase() || "P";
}

function sourceLabel(plugin: { source: string; subdirectory?: string }): string {
  if (plugin.source.startsWith("builtin:")) return "内置插件";
  const shorthand = plugin.source.replace(/^https?:\/\/(?:www\.)?/, "").replace(/\.git$/, "");
  return plugin.subdirectory ? `${shorthand}#${plugin.subdirectory}` : shorthand;
}

function ComponentChips({ plugin }: { plugin: InstalledPlugin }) {
  const skills = plugin.skills.filter((skill) => skill.valid);
  const servers = plugin.mcpServers.filter((server) => server.valid);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className="rounded-full bg-hover px-2 py-0.5 text-label-2">{skills.length} 个技能</span>
      <span className="rounded-full bg-hover px-2 py-0.5 text-label-2">{servers.length} 个 MCP 服务</span>
    </div>
  );
}

function MarketplaceCard({
  plugin,
  installing,
  disabled,
  onInstall,
}: {
  plugin: MarketplacePlugin;
  installing: boolean;
  disabled: boolean;
  onInstall: () => void;
}) {
  return (
    <article className="flex h-full flex-col gap-3 rounded-[16px] border-[0.5px] border-line-3 bg-elevated p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-hover text-[15px] font-semibold text-label-2">
          {initialOf(plugin.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="min-w-0 truncate text-[14px] font-medium leading-5 text-label-1">{plugin.name}</h3>
            {plugin.version && <span className="shrink-0 text-[11px] text-label-3">v{plugin.version}</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] leading-4 text-label-3">
            {plugin.author && <span className="truncate">{plugin.author}</span>}
            <span>{plugin.category}</span>
            {plugin.license && <span>{plugin.license}</span>}
          </div>
        </div>
        {plugin.installed && <Badge variant="secondary">已安装</Badge>}
      </div>
      <p className="line-clamp-3 text-[13px] leading-5 text-label-2">
        {plugin.description || "暂无描述"}
      </p>
      {plugin.tags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {plugin.tags.slice(0, 5).map((tag) => (
            <span key={tag} className="rounded-[6px] bg-hover px-1.5 py-0.5 text-[11px] text-label-3">
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="mt-auto flex items-end justify-between gap-2 pt-1">
        <span className="min-w-0 truncate text-[11px] text-label-3" title={plugin.source}>
          {sourceLabel(plugin)}
        </span>
        <Button
          size="sm"
          variant={plugin.installed ? "outline" : "default"}
          disabled={disabled || plugin.installed}
          onClick={onInstall}
        >
          {installing
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : plugin.installed
              ? <Check className="h-3.5 w-3.5" />
              : <Download className="h-3.5 w-3.5" />}
          {plugin.installed ? "已安装" : "安装"}
        </Button>
      </div>
    </article>
  );
}

function InstalledCard({
  plugin,
  onUninstall,
  onToggle,
}: {
  plugin: InstalledPlugin;
  onUninstall: () => void;
  onToggle: (enabled: boolean) => void;
}) {
  const invalidComponents = plugin.skills.some((skill) => !skill.valid)
    || plugin.mcpServers.some((server) => !server.valid);
  return (
    <article className="rounded-[16px] border-[0.5px] border-line-3 bg-elevated p-4">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-hover text-[15px] font-semibold text-label-2">
          {initialOf(plugin.name)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="min-w-0 truncate text-[14px] font-medium leading-5 text-label-1">
              {plugin.displayName || plugin.name}
            </h3>
            {plugin.version && <span className="text-[11px] text-label-3">v{plugin.version}</span>}
            <Badge variant={plugin.conformance === "agent-plugins-1.0.0" ? "secondary" : "outline"}>
              {plugin.conformance === "agent-plugins-1.0.0" ? "Agent Plugins 1.0" : "兼容模式"}
            </Badge>
            {!plugin.enabled && <span className="text-[11px] text-label-3">已停用</span>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[12px] leading-4 text-label-3">
            <span className="truncate">{sourceLabel(plugin)}</span>
            {plugin.license && <span>{plugin.license}</span>}
          </div>
          {plugin.description && (
            <p className="mt-1.5 text-[13px] leading-5 text-label-2">{plugin.description}</p>
          )}
          <ComponentChips plugin={plugin} />
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Switch
            checked={plugin.enabled}
            aria-label={plugin.enabled ? "停用插件" : "启用插件"}
            onCheckedChange={onToggle}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`卸载 ${plugin.name}`}
            title="卸载插件"
            className="text-label-3 hover:text-destructive"
            onClick={onUninstall}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {plugin.error && (
        <p className="mt-3 flex items-start gap-2 rounded-[10px] bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{plugin.error}</span>
        </p>
      )}

      {(plugin.skills.length > 0 || plugin.mcpServers.length > 0) && (
        <div className="mt-3 space-y-1.5 border-t border-line-2 pt-3 text-[12px] leading-5">
          {plugin.skills.map((skill) => (
            <div key={`skill:${skill.path}`} className="flex min-w-0 items-baseline gap-2">
              <span className="w-9 shrink-0 text-label-3">技能</span>
              <span className={cn("min-w-0 flex-1 truncate", skill.valid ? "text-label-2" : "text-destructive")}>
                /{skill.name}
                {skill.error ? ` · ${skill.error}` : skill.description ? ` · ${skill.description}` : ""}
              </span>
            </div>
          ))}
          {plugin.mcpServers.map((server) => (
            <div key={`mcp:${server.id}`} className="flex min-w-0 items-baseline gap-2">
              <span className="w-9 shrink-0 text-label-3">MCP</span>
              <span className={cn("min-w-0 flex-1 truncate", server.valid ? "text-label-2" : "text-destructive")}>
                {server.label}
                {server.error ? ` · ${server.error}` : ` · ${server.transport}`}
              </span>
            </div>
          ))}
          {invalidComponents && (
            <p className="text-[11px] text-label-3">无效组件已按规范跳过,不会进入会话。</p>
          )}
        </div>
      )}

      {plugin.warnings.length > 0 && (
        <details className="mt-2 text-[12px] leading-5 text-label-3">
          <summary className="cursor-pointer select-none">{plugin.warnings.length} 条提示</summary>
          <ul className="mt-1 list-disc pl-5">
            {plugin.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </details>
      )}
    </article>
  );
}

export function PluginsPage() {
  const plugins = useApp((state) => state.plugins);
  const marketplaces = useApp((state) => state.pluginMarketplaces);
  const catalog = useApp((state) => state.pluginCatalog);
  const busy = useApp((state) => state.pluginBusy);
  const loadPlugins = useApp((state) => state.loadPlugins);
  const installPlugin = useApp((state) => state.installPlugin);
  const uninstallPlugin = useApp((state) => state.uninstallPlugin);
  const setPluginEnabled = useApp((state) => state.setPluginEnabled);
  const addPluginMarketplace = useApp((state) => state.addPluginMarketplace);
  const removePluginMarketplace = useApp((state) => state.removePluginMarketplace);

  const [tab, setTab] = useState<Tab>("market");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("全部");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [installOpen, setInstallOpen] = useState(false);
  const [installSource, setInstallSource] = useState("");
  const [installSubdirectory, setInstallSubdirectory] = useState("");
  const [marketOpen, setMarketOpen] = useState(false);
  const [marketSource, setMarketSource] = useState("");
  const [confirmName, setConfirmName] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    try {
      await loadPlugins();
      setError("");
    } catch (loadError) {
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // 进入页面时加载一次;之后的刷新由按钮与安装/卸载动作触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const categories = useMemo(() => {
    const values = new Set(catalog.map((plugin) => plugin.category).filter(Boolean));
    return ["全部", ...[...values].sort((left, right) => left.localeCompare(right))];
  }, [catalog]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return catalog.filter((plugin) => {
      if (category !== "全部" && plugin.category !== category) return false;
      if (!keyword) return true;
      return [plugin.name, plugin.description, plugin.author ?? "", plugin.tags.join(" ")]
        .some((value) => value.toLowerCase().includes(keyword));
    });
  }, [catalog, category, query]);

  const runInstall = async (
    source: string,
    subdirectory: string | undefined,
    pending: string,
  ) => {
    setError("");
    setNotice("");
    setPendingId(pending);
    try {
      const result = await installPlugin(source, subdirectory);
      const name = result.plugin.displayName || result.plugin.name;
      setNotice(
        result.skillsInstalled > 0
          ? `已安装 ${name},包含 ${result.skillsInstalled} 个技能`
          : `已安装 ${name}`,
      );
      setInstallOpen(false);
      setInstallSource("");
      setInstallSubdirectory("");
      setTab("installed");
    } catch (installError) {
      setError(errorMessage(installError));
    } finally {
      setPendingId(null);
    }
  };

  const addMarket = async () => {
    const source = marketSource.trim();
    if (!source) return;
    setError("");
    setNotice("");
    try {
      const market = await addPluginMarketplace(source);
      setNotice(`已添加市场 ${market.name}`);
      setMarketSource("");
      setMarketOpen(false);
    } catch (marketError) {
      setError(errorMessage(marketError));
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[16px] font-semibold leading-6 text-label-1">插件</h2>
          <p className="mt-1 text-[13px] leading-5 text-label-3">
            兼容{" "}
            <a
              className="text-[var(--ds-link)] hover:underline"
              href="https://agent-plugins.org/specification"
              target="_blank"
              rel="noreferrer"
            >
              Agent Plugins 1.0.0
            </a>{" "}
            标准:插件里的技能与 MCP 服务器直接进入会话,停用后立即撤出。
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" size="sm" disabled={loading || busy} onClick={() => void refresh()}>
            <RefreshCw className={cn("h-3.5 w-3.5", (loading || busy) && "animate-spin")} />
            刷新
          </Button>
          <Button type="button" size="sm" onClick={() => setInstallOpen((open) => !open)}>
            <Download className="h-3.5 w-3.5" />
            从 URL 安装
          </Button>
        </div>
      </header>

      {installOpen && (
        <div className="rounded-[16px] border-[0.5px] border-line-3 bg-elevated p-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={installSource}
              onChange={(event) => setInstallSource(event.target.value)}
              placeholder="git 地址、owner/repo 或服务器上的本地目录"
              aria-label="插件来源"
              autoFocus
            />
            <Button
              type="button"
              disabled={!installSource.trim() || pendingId !== null}
              onClick={() => void runInstall(installSource.trim(), installSubdirectory.trim() || undefined, "manual")}
            >
              {pendingId === "manual"
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Download className="h-3.5 w-3.5" />}
              安装
            </Button>
          </div>
          <Input
            className="mt-2"
            value={installSubdirectory}
            onChange={(event) => setInstallSubdirectory(event.target.value)}
            placeholder="可选:仓库内子目录,例如 plugins/aws-serverless"
            aria-label="插件子目录"
          />
          <p className="mt-2 text-[12px] leading-5 text-label-3">
            支持标准 Agent Plugin(<code>plugin.json</code> 声明 <code>$schema</code>),也支持
            Claude/Codex/Copilot 的插件目录(<code>.codex-plugin/plugin.json</code> 等,按兼容模式加载)。
          </p>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-[12px] bg-destructive/10 px-3 py-2 text-[13px] leading-5 text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-[12px] bg-hover px-3 py-2 text-[13px] leading-5 text-label-2">
          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0">{notice}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 rounded-[12px] bg-hover p-1">
          {([
            ["market", "市场"],
            ["installed", plugins.length > 0 ? `已安装 · ${plugins.length}` : "已安装"],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={cn(
                "rounded-[9px] px-2.5 py-1 text-[13px] leading-5 transition-colors",
                tab === value ? "bg-elevated text-label-1 shadow-sm" : "text-label-3 hover:text-label-2",
              )}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === "market" && (
          <div className="flex items-center gap-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索插件、作者或标签"
              aria-label="搜索插件"
              className="w-56"
            />
            <Button type="button" variant="outline" size="sm" onClick={() => setMarketOpen((open) => !open)}>
              <Plus className="h-3.5 w-3.5" />
              市场源
            </Button>
          </div>
        )}
      </div>

      {tab === "market" && marketOpen && (
        <div className="rounded-[16px] border-[0.5px] border-line-3 bg-elevated p-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              value={marketSource}
              onChange={(event) => setMarketSource(event.target.value)}
              placeholder="市场清单 URL(JSON,包含 plugins 数组)"
              aria-label="市场源地址"
            />
            <Button type="button" disabled={!marketSource.trim()} onClick={() => void addMarket()}>
              <Plus className="h-3.5 w-3.5" />
              添加
            </Button>
          </div>
          <ul className="mt-3 space-y-1.5">
            {marketplaces.map((marketplace) => (
              <li key={marketplace.id} className="flex items-center gap-2 text-[12px] leading-5">
                <Store className="h-3.5 w-3.5 shrink-0 text-label-3" />
                <span className="min-w-0 flex-1 truncate text-label-2">
                  {marketplace.name}
                  <span className="ml-1 text-label-3">{marketplace.source}</span>
                </span>
                {marketplace.kind === "builtin" ? (
                  <span className="shrink-0 text-[11px] text-label-3">内置</span>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`移除市场 ${marketplace.name}`}
                    title="移除市场"
                    className="text-label-3 hover:text-destructive"
                    onClick={() => {
                      void removePluginMarketplace(marketplace.id)
                        .catch((removeError: unknown) => setError(errorMessage(removeError)));
                    }}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {tab === "market" && (
        <>
          {categories.length > 2 && (
            <div className="flex flex-wrap gap-1.5">
              {categories.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={cn(
                    "rounded-full px-2.5 py-0.5 text-[12px] leading-5 transition-colors",
                    category === value
                      ? "bg-label-1 text-[var(--background)]"
                      : "bg-hover text-label-3 hover:text-label-2",
                  )}
                  onClick={() => setCategory(value)}
                >
                  {value}
                </button>
              ))}
            </div>
          )}
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-[16px] border-[0.5px] border-line-3 bg-elevated px-4 py-10 text-center">
              <Package className="h-5 w-5 text-label-caption" />
              <p className="text-[13px] text-label-3">
                {catalog.length === 0 ? "当前没有市场条目,检查网络后刷新,或添加自己的市场源。" : "没有匹配的插件。"}
              </p>
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {filtered.map((plugin) => (
                <MarketplaceCard
                  key={plugin.id}
                  plugin={plugin}
                  installing={pendingId === plugin.id}
                  disabled={pendingId !== null}
                  onInstall={() => void runInstall(plugin.source, plugin.subdirectory, plugin.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {tab === "installed" && (
        <div className="space-y-3">
          {plugins.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-[16px] border-[0.5px] border-line-3 bg-elevated px-4 py-10 text-center">
              <Package className="h-5 w-5 text-label-caption" />
              <p className="text-[13px] text-label-3">还没有安装插件。</p>
              <Button type="button" variant="outline" size="sm" onClick={() => setTab("market")}>
                去市场看看
              </Button>
            </div>
          ) : (
            plugins.map((plugin) => (
              <InstalledCard
                key={plugin.name}
                plugin={plugin}
                onUninstall={() => setConfirmName(plugin.name)}
                onToggle={(enabled) => {
                  setError("");
                  void setPluginEnabled(plugin.name, enabled)
                    .catch((toggleError: unknown) => setError(errorMessage(toggleError)));
                }}
              />
            ))
          )}
        </div>
      )}

      <p className="text-[12px] leading-5 text-label-3">
        已加载 {plugins.length} 个插件 · 市场条目 {catalog.length} 个 · {marketplaces.length} 个市场源。
        插件的技能会出现在「技能」页且只读,可在输入框用 <code>/技能名</code> 调用。
      </p>

      <ConfirmDialog
        open={confirmName !== null}
        onOpenChange={(open) => !open && setConfirmName(null)}
        title="卸载插件?"
        description={`将删除插件“${confirmName ?? ""}”的文件与其数据目录,已加入会话的技能和 MCP 会立即移除。`}
        confirmLabel="卸载"
        destructive
        onConfirm={() => {
          const name = confirmName;
          setConfirmName(null);
          if (!name) return;
          setError("");
          void uninstallPlugin(name)
            .then(() => setNotice(`已卸载 ${name}`))
            .catch((uninstallError: unknown) => setError(errorMessage(uninstallError)));
        }}
      />
    </div>
  );
}
