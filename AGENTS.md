# AGENTS.md

## 命令

- 开发:`npm run dev`(server :8787 + web :5173)
- 类型检查:`npm run typecheck`(所有 workspace,改完代码必跑)
- 构建:`npm run build`
- 生产启动:`npm start`

## 结构

- `packages/protocol`:前后端共享的 WS 消息/领域类型(单一事实来源,改协议先改这里;`agentContract.ts` 是会话运行时契约,`agentPlugins.ts` 是 Agent Plugins 1.0 类型)
- `apps/server`:Fastify + DeepSeek Harness(`@deepseek-ai/dsh` + `@deepseek-ai/dsh-sdk-client`);`src/copilot.ts` 是会话管理核心(经 `src/agentRuntime.ts` 抽象缝调用 `src/dsh/` 的 DSH 运行时),`src/hub.ts` 是 WS 分发,`src/db.ts` + `src/store.ts` 是存储层(MySQL 优先,未配 `DATABASE_URL` 时回退 JSON 文件),`src/agentPluginHost.ts` 是 Agent Plugins 1.0 插件管理,`src/mcpToolsServer.ts` 是自定义工具(git/浏览器/资源管理)经 MCP 接入 Harness 运行时的桥
- `apps/web`:React 19 + Tailwind v4 + zustand;状态集中在 `src/lib/store.ts`,WS 客户端在 `src/lib/client.ts`

## 约定

- 不设 lint;以 `npm run typecheck` 为准
- UI 文案使用中文
- 不要引入 Effect、Electron、多 CLI agent 支持
- 执行核心是 DeepSeek Harness SDK 运行时(`dsh --profile sdk`,stdio JSON-RPC);运行时差异记在 `src/dsh/dshConfig.ts` 与 `src/dsh/dshWire.ts` 的注释里,升级 `@deepseek-ai/*` 依赖时对照其 .d.ts 校验 `dshWire.ts`
