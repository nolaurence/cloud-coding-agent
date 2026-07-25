# Cloud Coding Agent

基于 [GitHub Copilot SDK](https://github.com/github/copilot-sdk) 的云端编码 Agent,提供 Web 对话界面。Agent 的引擎是 Copilot CLI 同款运行时:计划、工具调用、文件编辑、命令执行全部内置,无需自己实现 agent loop。

## 功能

- **对话流**(自研,非 assistant-ui):流式输出、思考过程折叠、工具调用时间线、Markdown 渲染
- **模型配置**:支持 OpenAI(Chat Completions)与 OpenAI Responses 两种 wire 协议,以及 Azure / Anthropic;BYOK,按会话切换模型
- **MCP 模块**:本地 stdio / 远程 HTTP MCP 服务器管理,按工具白名单启用
- **Skill 模块**:SKILL.md 技能管理(新建/编辑/启停/外部目录),输入框 `/技能名` 调用
- **输入框增强**:`@` 引用项目文件(自动作为附件发送)、`/` 选择技能
- **项目管理**:一个项目 = 服务器上的一个工作目录,会话在其 cwd 中执行

## 架构

```
apps/web (React 19 + Vite + Tailwind v4 + zustand + react-router)
      │  WebSocket /ws (JSON 协议,见 packages/protocol)
apps/server (Fastify + @github/copilot-sdk)
      │  JSON-RPC
Copilot CLI runtime(会话、工具、MCP、技能)
```

数据默认存于 `~/.cloud-coding-agent`(可用 `CCA_DATA_DIR` 覆盖):设置、项目、会话元数据、技能、Copilot 会话状态。

## 本地开发

```bash
npm install
npm run dev        # server :8787 + web :5173(代理 /ws)
```

## 生产

```bash
npm run build      # 构建 web
npm start          # server 于 :8787 提供 API + 静态页面
```

## Docker 云端部署

```bash
docker compose up -d --build
# 打开 http://localhost:8787,添加项目目录(如 /workspace/your-repo)
```

compose 默认把 `./workspace` 挂到容器的 `/workspace`,把宿主代码放进去即可被 Agent 操作。会话/技能/配置持久化在 `agent-data` volume。

## 使用

1. 左侧边栏「添加项目目录」→ 填服务器上的绝对路径
2. 设置 → 模型:添加一个 OpenAI 兼容服务(填 baseUrl、apiKey、模型列表;Responses 协议选 `openai-responses`)
3. 设置 → 通用:选择默认模型
4. 回到首页,输入任务开聊;`@` 引用文件,`/` 选择技能
5. 设置 → MCP / 技能:按需接入外部工具与提示词模块

> GitHub Copilot 登录态也可作为模型来源(`models.list` 会合并 Copilot 可用模型),需在服务器上先 `copilot` 登录。BYOK 配置后无需 GitHub 鉴权。
