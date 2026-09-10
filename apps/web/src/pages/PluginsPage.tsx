import { Link } from "react-router-dom";

export function PluginsPage() {
  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">扩展工具</h2>
      <p className="text-sm text-muted-foreground">当前引擎已切换为 Codex，不支持 Copilot 插件市场。已有插件不会自动迁移。</p>
      <div className="flex gap-4 text-sm underline">
        <Link to="/skills">管理技能</Link>
        <Link to="/settings/mcp">管理 MCP</Link>
      </div>
    </div>
  );
}
