# AGENTS.md

## 命令

- 开发:`npm run dev`(server :8787 + web :5173)
- 类型检查:`npm run typecheck`(所有 workspace,改完代码必跑)
- 构建:`npm run build`
- 生产启动:`npm start`

## 结构

- `packages/protocol`:前后端共享的 WS 消息/领域类型(单一事实来源,改协议先改这里)
- `apps/server`:Fastify + `@github/copilot-sdk`;`src/copilot.ts` 是会话管理核心,`src/hub.ts` 是 WS 分发,`src/db.ts` + `src/store.ts` 是存储层(Postgres 优先,未配 `DATABASE_URL` 时回退 JSON 文件)
- `apps/web`:React 19 + Tailwind v4 + zustand;状态集中在 `src/lib/store.ts`,WS 客户端在 `src/lib/client.ts`

## 约定

- 不设 lint;以 `npm run typecheck` 为准
- UI 文案使用中文
- 不要引入 Effect、Electron、多 CLI agent 支持
