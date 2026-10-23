# AGENTS.md

## 命令

- 开发:`npm run dev`(server :8787 + web :5173;会先构建 DSH UI 插件)
- 类型检查:`npm run typecheck`(所有 workspace,改完代码必跑)
- 构建:`npm run build`(web + dsh-web + server + desktop)
- 生产启动:`npm start`

## 结构

- `packages/protocol`:前后端共享的 WS 消息/领域类型(单一事实来源,改协议先改这里)
- `apps/dsh-web`:搬入本仓库的 DeepSeek Harness Web 外壳源码(Vite + React 18)。`src/` 是 boot 入口,`scripts/build-plugins.mjs` 把 `plugins/*` 编译成 DSH 的 `__ModuleLoader__` client bundle;`plugins/sidebar`、`plugins/brand` 覆盖官方 UI 行
- `apps/server`:Fastify + 官方 `@deepseek-ai/dsh`。`src/dshManager.ts` 按用户管理 `dsh --profile web` 子进程,`src/dshProfile.ts` 生成 profile overlay(模型网关、sandbox、本地 UI 插件行),`src/dshProxy.ts` 在 `/dsh/` 提供自建外壳、注入 `__DSH_BOOT__` 并代理插件/API,`src/dshAgent.ts` 用 `@deepseek-ai/dsh-sdk-client` 驱动 `dsh --profile sdk`
- `apps/web`:React 19 + Tailwind v4 + zustand;只保留登录、管理设置、分享页。登录后整页跳到 `/dsh/`,不再有 iframe 和 CCA NavRail
- 旧 Codex/Copilot 代码(`codex.ts`、`copilot.ts`)保留用于历史兼容,不要在主路径继续扩展

## 约定

- 不设 lint;以 `npm run typecheck` 为准
- UI 文案使用中文
- DSH 核心用官方 npm 包,不要修改 `node_modules`;UI 源码放 `apps/dsh-web`,通过本地 client 插件覆盖
- 不要引入 Effect、Electron、多 CLI agent 支持
