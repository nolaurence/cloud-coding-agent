# Cloud Coding Agent

基于 [GitHub Copilot SDK](https://github.com/github/copilot-sdk) 的云端编码 Agent,提供 Web 对话界面。Agent 的引擎是 Copilot CLI 同款运行时:计划、工具调用、文件编辑、命令执行全部内置,无需自己实现 agent loop。

## 功能

- **对话流**(自研,非 assistant-ui):流式输出、思考过程折叠、工具调用时间线、Markdown 渲染
- **模型配置**:支持 OpenAI(Chat Completions)与 OpenAI Responses 两种 wire 协议,以及 Azure / Anthropic;BYOK,按会话切换模型
- **MCP 模块**:本地 stdio / 远程 HTTP MCP 服务器管理,按工具白名单启用
- **Skill 模块**:SKILL.md 技能管理(新建/编辑/启停/外部目录),输入框 `/技能名` 调用
- **输入框增强**:`@` 引用项目文件(自动作为附件发送)、`/` 选择技能
- **项目管理**:一个项目 = 服务器上的一个工作目录,会话在其 cwd 中执行
- **代码托管账户**:在「设置 → 通用」绑定 GitHub / Gitee,Agent 可使用当前用户的授权执行 clone、fetch、pull、push
- **用户系统**:登录/注册;管理员由环境变量 `ADMIN_USERNAME`/`ADMIN_PASSWORD` 创建,注册用户为普通用户;会话按用户隔离,管理员可见全部
- **数据存储**:内置 SQLite 单文件部署,也可连接 MySQL,并兼容旧 JSON 数据迁移

## 架构

```
apps/web (React 19 + Vite + Tailwind v4 + zustand + react-router)
      │  WebSocket /ws (JSON 协议,见 packages/protocol)
apps/server (Fastify + @github/copilot-sdk)
      │  JSON-RPC
Copilot CLI runtime(会话、工具、MCP、技能)
```

数据存储支持三种模式:`DATABASE_URL=sqlite:/path/to/cca.db` 使用内置 SQLite,`DATABASE_URL=mysql://...` 使用 MySQL;两者都会自动建表并从旧 JSON 文件迁移。未配置时继续使用 JSON 文件存储(默认 `~/.cloud-coding-agent`,可用 `CCA_DATA_DIR` 覆盖)。会话消息历史由 Copilot CLI 持久化在数据目录的 `copilot-home/` 下。

## 本地开发

需要 Node.js 22.13 或更高版本。

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

单容器 SQLite 部署(推荐用于单机和个人服务):

```bash
cp .env.standalone.example .env
# 修改 .env 中的 ADMIN_PASSWORD
docker compose -f docker-compose-standalone.yml up -d --build
# 打开 http://localhost:8787
```

该 Compose 只启动 `agent`,数据库位于持久化卷中的 `/data/cca.db`,无需额外数据库服务。`WORKSPACE_DIR` 指定挂载到容器 `/workspace` 的代码目录。请勿让多个容器同时挂载并写入同一个 SQLite 数据文件;需要多实例时使用外部 MySQL。

内置 MySQL 的开发部署:

```bash
docker compose up -d --build
# 打开 http://localhost:8787,添加项目目录(如 /workspace/your-repo)
```

compose 会同时拉起 `mysql:8.4`(`db` 服务,`mysql-data` volume 持久化,健康检查通过后才启动 agent),通过 `DATABASE_URL` 指向它;`MYSQL_USER`/`MYSQL_PASSWORD`/`MYSQL_DATABASE`/`MYSQL_ROOT_PASSWORD` 可在 `.env` 覆盖。compose 默认把 `./workspace` 挂到容器的 `/workspace`,把宿主代码放进去即可被 Agent 操作。

使用外部 MySQL 的生产部署:

```bash
cp .env.prod.example .env
# 配置 .env 中的 DATABASE_URL 和管理员密码
docker compose -f docker-compose-prod.yml up -d --build
# 默认打开 http://localhost:7001
```

生产 Compose 只启动 `agent`,不会拉起 MySQL。默认使用宿主机端口 `7001`;可用 `APP_PORT` 修改宿主机端口,用 `WORKSPACE_DIR` 修改挂载到 `/workspace` 的代码目录;容器内服务固定监听 `8787`。当前 Compose 还将宿主机 `/home/nolaurence/dev` 挂载到容器 `/codeprojects`,因此本项目在界面中应添加为 `/codeprojects/cloud-coding-agent`。`.env` 已被 git 忽略。
外部 MySQL 用户需要目标数据库的 `CREATE`/`SELECT`/`INSERT`/`UPDATE`/`DELETE` 权限;`DATABASE_URL` 密码中的 URL 保留字符需要百分号编码。

## 使用

1. 打开页面,使用管理员账户登录(开发 Compose 默认 `admin`/`admin123`;生产 Compose 使用 `.env` 中的配置),或注册普通账户
2. 左侧边栏「添加项目目录」→ 填服务器上的绝对路径
2. 设置 → 模型:添加一个 OpenAI 兼容服务(填 baseUrl、apiKey、模型列表;Responses 协议选 `openai-responses`)
3. 设置 → 通用:选择默认模型
4. 如需操作远程仓库,在设置 → 通用中使用具备仓库读写权限的访问令牌绑定 GitHub 或 Gitee
5. 回到首页,输入任务开聊;`@` 引用文件,`/` 选择技能
6. 设置 → MCP / 技能:按需接入外部工具与提示词模块

绑定令牌使用服务端密钥加密保存,按会话所属用户读取。Agent 通过受控的 `authenticated_git` 工具执行远程 Git 操作;令牌不会写入仓库 URL、`.gitconfig` 或 Web 终端环境。HTTPS 和常见 SSH remote 会统一通过对应平台的 HTTPS 认证执行。

> GitHub Copilot 登录态也可作为模型来源(`models.list` 会合并 Copilot 可用模型),需在服务器上先 `copilot` 登录。BYOK 配置后无需 GitHub 鉴权。
