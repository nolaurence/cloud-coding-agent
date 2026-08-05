# Cloud Coding Agent

基于 [GitHub Copilot SDK](https://github.com/github/copilot-sdk) 的云端编码 Agent,提供 Web 对话界面。Agent 的引擎是 Copilot CLI 同款运行时:计划、工具调用、文件编辑、命令执行全部内置,无需自己实现 agent loop。

## 功能

- **对话流**(自研,非 assistant-ui):流式输出、思考过程折叠、工具调用时间线、Markdown 渲染
- **模型配置**:支持 OpenAI(Chat Completions)与 OpenAI Responses 两种 wire 协议,以及 Azure / Anthropic;BYOK,按会话切换模型
- **MCP 模块**:本地 stdio / 远程 HTTP MCP 服务器管理,按工具白名单启用
- **Skill 模块**:SKILL.md 技能管理(新建/编辑/启停/外部目录),输入框 `/技能名` 调用
- **输入框增强**:`@` 引用项目文件(自动作为附件发送)、`/` 选择技能
- **项目管理**:一个项目 = 服务器上的一个工作目录,会话在其 cwd 中执行
- **工作区沙箱**:基于 Copilot 运行时的一方沙箱(bubblewrap),每个会话的工具只能读写所属工作区;服务端数据目录和其他工作区被显式拒绝,且禁止沙箱绕过。Linux 部署需要安装 bubblewrap(Docker 镜像已内置)并允许非特权用户命名空间
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

## Standalone 部署

Standalone 模式使用内置 SQLite,适合单机或个人服务。应用数据、用户配置、会话记录和 Copilot 运行时状态需要持久化到同一个数据目录;不要让多个实例同时读写同一个 SQLite 文件。

### 使用 Docker(推荐)

需要 Docker 和 Docker Compose。仓库已提供单容器 Compose 配置:

```bash
cp .env.standalone.example .env
# 修改 .env 中的 ADMIN_PASSWORD;按需设置 APP_PORT 和 WORKSPACE_DIR
docker compose -f docker-compose-standalone.yml up -d --build
```

部署完成后打开 `http://localhost:8787`(修改了 `APP_PORT` 时使用对应端口)。SQLite 数据库和其他应用数据保存在 `agent-data` volume 中;宿主机的 `WORKSPACE_DIR` 会挂载到容器 `/workspace`,在界面中添加项目时应使用 `/workspace` 下的容器路径。

镜像内置 Chromium、Xvfb、x11vnc、websockify 和 noVNC。每个会话会按需启动隔离的浏览器、显示服务和用户目录;右侧「浏览器」面板通过同源 WebSocket 显示该会话,Agent 则使用 `browser_use` 工具导航、查看页面、点击和输入,无需额外暴露 VNC 端口。浏览器默认禁止访问本机、内网和云元数据地址;如需让 Agent 调试本地开发服务,请显式设置 `BROWSER_ALLOW_PRIVATE_NETWORK=true`。

常用维护命令:

```bash
docker compose -f docker-compose-standalone.yml logs -f agent
docker compose -f docker-compose-standalone.yml restart agent
docker compose -f docker-compose-standalone.yml down       # 保留 agent-data 数据卷
```

### 不使用 Docker

需要 Node.js 22.13 或更高版本、npm、Git、Chromium、Xvfb、x11vnc、websockify 和 noVNC。Debian/Ubuntu 可执行 `sudo apt install chromium xvfb x11vnc websockify novnc` 安装浏览器链路。默认仅允许浏览器访问公网 HTTP/HTTPS 地址;如需访问本机或内网开发服务,启动时添加 `BROWSER_ALLOW_PRIVATE_NETWORK=true`。首次部署时安装依赖并构建前端:

```bash
git clone <本仓库地址> cloud-coding-agent
cd cloud-coding-agent
npm ci
npm run build
```

创建持久化数据目录和 Agent 工作目录,然后启动服务:

```bash
mkdir -p ./data ./workspace

CCA_DATA_DIR="$PWD/data" \
DATABASE_URL="sqlite:$PWD/data/cca.db" \
WORKSPACE_ROOT="$PWD/workspace" \
ADMIN_USERNAME="admin" \
ADMIN_PASSWORD="请替换为强密码" \
HOST="0.0.0.0" \
PORT="8787" \
npm start
```

服务启动后打开 `http://localhost:8787`。生产环境建议通过 systemd、Supervisor 等进程管理器托管上述命令,并使用 Nginx、Caddy 等反向代理配置 HTTPS 和 WebSocket 转发。必须持久化并备份 `CCA_DATA_DIR`;其中包含 SQLite 数据库、加密密钥、上传文件、技能和会话运行时状态。项目可以使用服务器上的任意绝对路径,由运行服务的系统用户负责读写权限。

如需修改监听端口或数据路径,调整对应环境变量后重启服务。升级时拉取新代码,重新执行 `npm ci && npm run build`,再重启进程。

## 其他 Docker 部署方式

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
