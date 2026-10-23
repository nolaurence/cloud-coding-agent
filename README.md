# Kloud Work · Cloud Coding Agent

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的多用户云端编码 Agent。Agent core 使用官方 `@deepseek-ai/dsh` 包；Web 外壳、侧边栏和品牌位是搬入本仓库的 DSH 源码（`apps/dsh-web`），其余聊天/工具 UI 仍由官方 client 插件提供。登录后整页运行在 `/dsh/`，不再使用 iframe。CCA 负责登录、用户、项目、模型提供方、部署和反向代理，DSH 负责会话、工具、UI 和 agent loop。

## 功能

- **DSH 原生 UI**：`apps/dsh-web` 是搬入的 DSH Web 外壳源码（Vite + React 18），由官方 host 注入 boot manifest；侧边栏和品牌位由本仓库的本地 client 插件接管，支持 CCA 的设置/退出入口；聊天、工具渲染等其余 UI 使用官方 `@deepseek-ai/dsh-client-*` 插件包
- **官方 agent core**：每个用户独立启动 `dsh --profile web` 进程，DSH 自己持有会话、工具调用、审批和文件状态；模型流量经 CCA 的本地 Responses 网关转发
- **程序化 agent 通道**：`@deepseek-ai/dsh-sdk-client` 驱动 `dsh --profile sdk`，提供 `POST /api/agent/run`，供连接器/自动化复用同一套官方运行时
- **用户系统**：登录/注册；管理员由环境变量 `ADMIN_USERNAME`/`ADMIN_PASSWORD` 创建；`/dsh/` 通过一次性 ticket 换取绑定 CCA 用户的 portal cookie，DSH 凭据不落浏览器
- **项目管理与隔离**：一个项目 = 服务器上的一个工作目录；每个用户独立 `DSH_HOME`、workspace、会话和 DSH 进程
- **模型配置**：支持 OpenAI Chat Completions / Responses 与 Azure OpenAI 兼容接口；BYOK，网关密钥只存在于服务端进程
- **管理设置**：`/settings` 保留模型、MCP、技能、连接器、用户和 Git 绑定等 CCA 管理页；`/` 登录后进入 DSH 工作台
- **数据存储**：内置 SQLite 单文件部署，也可连接 MySQL，并兼容旧 JSON 数据迁移
- **远程沙箱**：`DSH_SANDBOX_ENABLED=true` 时按用户配置 SSH 沙箱、文件/终端 provider 和工作区同步

## 架构

```
浏览器
  ├─ /login, /settings, /share/*   apps/web (React 19 + Tailwind + zustand)
  └─ /dsh/*                        apps/dsh-web (搬入的 DSH Web 外壳)
                                      │  服务端注入 __DSH_BOOT__ / 插件预加载
apps/server (Fastify)
  ├─ /dsh/ 外壳 HTML + 静态资源
  ├─ /dsh/api/*, /dsh/plugins/*  → 每个用户的 dsh --profile web（官方 @deepseek-ai/dsh）
  ├─ /api/agent/run              → @deepseek-ai/dsh-sdk-client（dsh --profile sdk）
  └─ 登录/用户/项目/设置/连接器/本地 LLM 网关
```

DSH 的 Web 前端不是独立应用：`dsh web` 会向页面注入 `window.__DSH_BOOT__`、插件预加载和主题初始化。CCA 在 `/dsh/` 取回当前用户 host 渲染的 index.html，把这些注入块拼进 `apps/dsh-web/dist/index.html`，再把 `/dsh/api`、`/dsh/plugins` 和 WebSocket 转发到该用户的 DSH 进程。`apps/dsh-web/plugins` 下的 `sidebar`、`brand` 会在构建时生成 DSH 的 `__ModuleLoader__` client bundle，并通过 `cca-integration.json` 覆盖官方同 id 的 profile 行。

数据存储支持三种模式:`DATABASE_URL=sqlite:/path/to/cca.db` 使用内置 SQLite,`DATABASE_URL=h2:/path/to/cca.db` 是桌面本地模式使用的内置嵌入式数据库别名,`DATABASE_URL=mysql://...` 使用 MySQL;两者都会自动建表并从旧 JSON 文件迁移。未配置时继续使用 JSON 文件存储(默认 `~/.cloud-coding-agent`,可用 `CCA_DATA_DIR` 覆盖)。DSH 会话、workspace 和配置保存在 `$DSH_HOME/users/<用户名 SHA-256>/`；CCA 的线程/分享/连接器数据仍在 `CCA_DATA_DIR`，备份时两者都需要覆盖。旧 Codex/Copilot 代码保留在仓库中用于历史兼容，但主界面和主 agent 已不再走它们。

## 本地开发

需要 Node.js 22.13 或更高版本。`@deepseek-ai/dsh` 是 `apps/server` 的生产依赖，`npm install` 会一并安装。

```bash
npm install
npm run dev        # server :8787 + web :5173
                   # 登录/管理:http://localhost:5173
                   # DSH 工作台:http://localhost:8787/dsh/(5173 也会代理 /dsh)
```

`npm run dev` 会先构建 `apps/dsh-web`（外壳 + 本地 client 插件），再启动 server。只改 DSH 外壳或插件后重新运行 `npm run build -w @cca/dsh-web`；只重建插件可运行 `npm run build:plugins -w @cca/dsh-web`。

## Desktop(macOS / Windows)

Electron 桌面版运行本地模式:关闭登录、注册和用户管理,使用 `userData/cca.db` 的内置嵌入式数据库,首次创建工作区时可通过原生文件夹选择器登记任意本地目录。数据和默认工作区保存在 Electron `userData` 目录;应用内启动同一个 Fastify 服务并使用随机的 `127.0.0.1` 端口。桌面进程设置 `BROWSER_BACKEND=electron-ipc`:每个会话使用独立、非持久化且沙箱化的 Electron `WebContentsView`,右侧浏览器面板显示该原生视图。请求会在服务子进程与 Electron 主进程之间通过受验证、限时的 IPC 转发;仅支持 `browser_use` 的固定操作,不提供任意 JavaScript。非桌面部署仍使用原有 Linux Xvfb/Chromium/noVNC 后端。

```bash
npm ci
npm run desktop          # 构建并启动未打包应用
npm run desktop:dir      # 生成可运行的未安装包,便于检查
npm run desktop:dist     # 当前平台生成 DMG/ZIP 或 NSIS 安装包
```

发布配置只构建当前主机架构。为覆盖 macOS Intel/Apple Silicon 与 Windows x64/arm64,请使用 `macos-*-x64`、`macos-*-arm64`、`windows-*-x64`、`windows-*-arm64` 四个原生 runner（可组成 CI matrix）,在每个 runner 上从干净目录执行 `npm ci && npm run desktop:dist`。不要在单个 runner 上用 `--x64 --arm64` 交叉打包。`node-pty`、Koffi、Codex 及兼容依赖的平台运行时保留在 ASAR 外;`npm ci` 会按构建主机安装对应可选平台包；`node-pty` 必须存在目标 OS/架构预编译文件（或在目标 runner 上安装编译工具后构建）。跨架构发布前请在每个目标架构的 runner 上执行并冒烟测试,不要复用其他平台的 `node_modules`。 浏览器网络策略会在顶层导航及 Electron 请求拦截阶段重新解析主机并拒绝本机、私网、链路本地和元数据目标（除非设置 `BROWSER_ALLOW_PRIVATE_NETWORK=true`）；这属于尽力过滤,不是 DNS pinning。正式发布还需配置 Apple Developer ID 签名/公证和 Windows Authenticode 证书;本仓库不会存放证书。产物写入 `release/`。

> 桌面打包目前没有把 DSH runtime 和 `apps/dsh-web` 一起塞进安装包；桌面本地模式打开 `/` 时若 DSH 不可用会显示可重试的错误页。真正的 DSH 工作台目前面向 Docker/服务器部署。



## Standalone 部署

Standalone 模式使用内置 SQLite,适合单机或个人服务。应用数据、用户配置、会话记录和 Codex 运行时状态需要持久化到同一个数据目录;不要让多个实例同时读写同一个 SQLite 文件。

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

DeepSeek Harness 的 workspace 实际运行在 sandbox 主机上。首次启动时,服务会把容器 `/workspace` 通过受限 `rrsync` 增量种子同步到 `DSH_SANDBOX_HOST_WORKSPACE`(默认 `/home/nolaurence/cca-workspaces/default`),使用 `--ignore-existing` 保留 sandbox 中已经生成的文件。成功后写入 `$DSH_HOME/.workspace-sync-v1.json`;需要重新导入时删除该标记并重启。安装 sandbox 时使用 `deploy/dsh/sandbox-install.sh <sandbox-pubkey> [workspace-sync-pubkey]` 同时登记网关密钥和同步密钥。

## 使用

1. 打开 `/`,使用管理员账户登录(开发 Compose 默认 `admin`/`admin123`;生产 Compose 使用 `.env` 中的配置),或注册普通账户
2. 登录成功后浏览器整页进入 `/dsh/`;左侧是 DSH 侧边栏(本地源码插件),底部「设置 / 退出」回到 CCA 管理页或退出登录
3. 管理员在 `/settings/providers` 添加 OpenAI 兼容服务(baseUrl、apiKey、模型列表;Responses 协议选 `openai-responses`),在 `/settings/general` 选择默认模型
4. 如需操作远程仓库,在 `/settings/general` 用具备仓库读写权限的访问令牌绑定 GitHub 或 Gitee
5. 在 DSH 工作台里新建会话、选择工作区并输入任务;`@` 引用文件,`/` 调用 DSH 指令/技能
6. `/settings/mcp`、`/settings/connectors`、`/settings/users` 管理 CCA 侧的 MCP、连接器和用户
7. 需要让外部程序驱动 agent 时,管理员可调用 `POST /api/agent/run`(Bearer 管理员 token,body `{"prompt":"..."}`);它走官方 `@deepseek-ai/dsh-sdk-client`，与 Web 工作台共用模型网关

绑定令牌使用服务端密钥加密保存,按会话所属用户读取。Agent 通过受控的 `authenticated_git` 工具执行远程 Git 操作;令牌不会写入仓库 URL、`.gitconfig` 或 Web 终端环境。HTTPS 和常见 SSH remote 会统一通过对应平台的 HTTPS 认证执行。

### 模型接入与兼容范围

主路径是 DSH：`/settings/providers` 里配置的每个 provider 会启动一个本地 Responses 网关，DSH 通过 `llm-pi-ai` 的 `openai-responses` 路由访问它。Base URL 填 API 根路径(例如含 `/v1`),选择 `completions` 或 `responses`,再设置默认模型；Chat 上游必须支持 `stream: true`、function tool calling 和 SSE。

旧 Codex/Copilot 兼容代码仍保留在 `apps/server/src/codex.ts`、`copilot.ts` 中，供历史会话和连接器迁移使用；它们不再是 Web 工作台或默认 agent 的核心。新增能力应优先落到 DSH 插件/技能/MCP，而不是继续扩展旧适配器。

图片生成通过 Codex 原生 MCP 工具通道注册 `cca_imagegen.image_gen`,新会话和恢复的旧会话均可发现并调用。仅当已配置的 OpenAI 提供商中存在 `gpt-image` 或 `gpt-image-*` 模型时启用;优先使用当前聊天提供商,否则按配置顺序选择第一个有 GPT Image 模型的提供商,并使用该提供商列表中第一个匹配的模型。生图通过所选提供商的 `/images/generations` 接口执行,使用服务端已有凭据,无需在运行环境配置额外的 `OPENAI_API_KEY` 或确认 CLI 回退;当前入口仅支持生成新图片。生成结果作为助手图片附件保存,支持聊天内预览、刷新恢复和 QQ 私聊/群聊/频道原生图片回传;单张图片限制 10 MB,计入现有图片存储额度。

不保证所有 OpenAI 兼容服务的扩展字段兼容;暂不支持依赖 `previous_response_id` 的服务端状态、原生 Anthropic、跨协议加密推理历史、Copilot 插件市场和 Ultra 子代理模式。扩展请使用现有 Skill/MCP 管理。自动提交信息通过自定义模型服务执行纯文本请求,不开放工具;原生 Codex 账号暂需手动填写提交信息。上游 API key 保留在服务端网关,子进程仅持有会话级随机网关凭证;本地网关不对外发布端口。

也可使用 Codex 原生账号:在运行服务的系统用户下,将 `CODEX_HOME` 指向 `$CCA_DATA_DIR/codex-home` 后,执行 `node node_modules/@openai/codex/bin/codex.js login`。服务会在打开会话时同步该目录的认证信息,不使用旧 Copilot 登录态。修改/清除认证后应重启服务以关闭旧会话。可通过 `CCA_CODEX_PATH` 指定同版本 Codex 可执行文件。请勿把认证文件放到项目工作区。
