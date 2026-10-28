# AGENTS.md

## 命令

- 开发:`npm run dev`(server :8787 + web :5173)
- 类型检查:`npm run typecheck`(所有 workspace,改完代码必跑)
- 构建:`npm run build`
- 生产启动:`npm start`

## 结构

- `packages/protocol`:前后端共享的 WS 消息/领域类型(单一事实来源,改协议先改这里)
- `apps/server`:Fastify + 执行引擎适配层;`src/copilot.ts` 是会话管理核心,`src/codex.ts` 是 Codex 引擎,`src/dsh/` 是 DeepSeek Harness 引擎(配置、事件映射、SDK 会话),`src/hub.ts` 是 WS 分发,`src/db.ts` + `src/store.ts` 是存储层(MySQL 优先,未配 `DATABASE_URL` 时回退 JSON 文件)
- `apps/server` 直接声明了 DSH SDK 的 peer 依赖(`@deepseek-ai/cordis`、`dsh-llm`、`dsh-sdk-protocol`、`dsh-session`);这是为了让 npm 把 DSH 插件树收敛成 `node_modules` 里的一份副本,删除会导致工具调度器跨副本 Symbol 失配、所有 DSH 工具调用失败
- `apps/web`:React 19 + Tailwind v4 + zustand;状态集中在 `src/lib/store.ts`,WS 客户端在 `src/lib/client.ts`

## 约定

- 不设 lint;以 `npm run typecheck` 为准
- UI 文案使用中文
- 执行引擎只有 Codex 与 DSH(DeepSeek Harness)两种,由新建会话时的 `thread.create.runtime` 选择;不要引入第三种 CLI agent 支持,也不要引入 Effect、Electron
