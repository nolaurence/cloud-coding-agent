# Cloud Coding Agent

基于 [OpenAI Codex](https://github.com/openai/codex) app-server 与 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) SDK 运行时的云端编码 Agent,提供 Web 对话界面。新建会话时可选择执行引擎:Codex 沿用现有 stdio JSON-RPC 适配;DSH 通过 `dsh --profile sdk` 子进程运行。现有业务事件和工具定义仍复用 Copilot SDK 类型。

## 功能

- **执行引擎**:新建任务时可选 Codex(默认)或 DeepSeek Harness(DSH);同一套对话、工具时间线与历史存储
- **对话流**(自研,非 assistant-ui):流式输出、思考过程折叠、工具调用时间线、Markdown 渲染
- **Office 查看器**:工作区内的 DOCX、XLSX、PPTX 可在右侧 tab 中只读预览
- **工作台布局**:右上角按钮可将对话区与工作区面板互换,位置会在本机记住
- **会话管理**:侧栏每个工作区默认展示 6 个会话,可展开/收起和置顶;会话删除改为归档,「设置 → 归档对话」按工作区分组、按归档时间倒序展示,归档满 30 天后自动删除
- **模型配置**:支持 OpenAI(Chat Completions)与 OpenAI Responses 两种 wire 协议,以及 Azure 的 OpenAI 兼容接口;BYOK,会话内可切换同一提供方的模型。暂不支持 Anthropic 原生 Messages 协议
- **MCP 模块**:本地 stdio / 远程 HTTP MCP 服务器管理,支持平台级配置和 workspace 根目录 `.mcp.json`,按工具白名单启用
- **Skill 模块**:SKILL.md 技能管理(新建/编辑/启停/外部目录),支持平台级技能和 workspace `.github/skills/<name>/SKILL.md`,输入框 `/技能名` 调用
- **插件市场**:兼容 [Agent Plugins 1.0.0](https://agent-plugins.org/specification) 标准(`plugin.json` + `skills/` + `mcp.json`),也兼容 Claude/Codex/Copilot 布局的插件目录;内置一方法插件与官方仓库精选,支持从 git 地址、`owner/repo` 或本地目录安装,插件贡献的技能与 MCP 服务器自动进入会话,可随时停用/卸载
- **输入框增强**:`@` 引用项目文件(自动作为附件发送)、`/` 选择技能
- **项目管理**:一个项目 = 服务器上的一个工作目录,会话在其 cwd 中执行
- **代码托管账户**:在「设置 → 通用」绑定 GitHub / Gitee,Agent 可使用当前用户的授权执行 clone、fetch、pull、push
- **用户系统**:登录/注册;管理员由环境变量 `ADMIN_USERNAME`/`ADMIN_PASSWORD` 创建,注册用户为普通用户;会话按用户隔离,管理员可见全部
- **数据存储**:内置 SQLite 单文件部署,也可连接 MySQL,并兼容旧 JSON 数据迁移

## 会话概览与资源用量

会话右上角的「会话概览」按钮打开独立侧栏，宽屏默认展示，窄屏使用抽屉。包含当前概况、需要你处理（无待办时隐藏）、关键结论、任务进度、成果与验证，以及资源用量。打开工作区面板时自动让出空间。

- 目标与关键结论支持编辑，结论支持固定和跳回来源回合，随会话保存。最近答复摘录明确标记为未确认，不会覆盖人工结论。
- 任务进度来自 Codex 原生计划或 DSH Todo 事件；没有原生计划时读取答复中的勾选清单，不臆测完成百分比。文件操作、附件与验证记录来自实际消息和工具事件，不额外请求模型。
- 资源用量每 5 秒读取一次，页面隐藏或断线时暂停。优先通过 Kubernetes Metrics API 聚合当前 Pod 各容器的 CPU 与内存；需要 Metrics Server，以及应用 ServiceAccount 对本命名空间 `pods` 和 `metrics.k8s.io/pods` 的 `get` 权限。可通过 Downward API 配置 `POD_NAME`、`POD_NAMESPACE`，未配置时使用主机名与 ServiceAccount 命名空间。
- 无法取得 Pod 聚合指标时回退到应用所在容器的 cgroup v1/v2，并明确标示不包含其他容器。非容器环境显示当前服务器整机指标。这里监控的是应用服务端运行环境，不是浏览器或远程 MCP 服务。CPU 百分比按资源上限／可用 CPU 归一化，内存按硬上限计算；无上限时仅展示实际用量，首次 CPU 采样不伪造利用率。

相关测试：`npm run test:overview -w @cca/server`。

## 架构

```
apps/web (React 19 + Vite + Tailwind v4 + zustand + react-router)
      │  WebSocket /ws (JSON 协议,见 packages/protocol)
apps/server (Fastify + Codex/DSH 适配层)
      ├─ Codex app-server(stdio JSON-RPC:会话、工具、MCP、技能)
      │     └─ 本地鉴权网关 → 原生 Responses / Chat Completions 上游
      └─ DSH SDK 运行时(dsh --profile sdk,stdio JSON-RPC)
            └─ pi-ai 路由 → 自定义 OpenAI 兼容 / Anthropic 模型服务
```

### 执行引擎

- **Codex(默认)**:完整沿用原有模型、工具、浏览器、Git 授权、Office 与插件能力,使用 Codex 内置账号或配置的模型服务。
- **DSH**:每个会话独立 `$DSH_HOME` 与 `dsh` 子进程,模型路由、MCP、技能与文件沙箱在启动前写入会话专属 patch;会话历史同时写入 `dsh-home/<会话 ID>/` 与应用事件库。DSH 会话必须选择「设置 → 模型服务」中配置的自定义模型(不能使用 Codex 内置模型,暂不支持 Azure 提供方)。
- **DSH 会话统计**:DSH 会话底部显示轮/步、输出速度(tok/s)、token 总量、缓存命中率与上下文占比;数据来自 DSH 的 `sessionStats` 口径与每条 `assistant/message` 的 usage,跨进程会随线程元数据持久化。Codex 会话保持原布局。
- DSH 的权限模式映射为文件沙箱(`request`/`auto` → `workspace-write`,`full` → `danger-full-access`),SDK 协议不支持交互式逐条审批,因此审批策略固定为拒绝升级、不阻塞执行。
- DSH 当前限制:文本在回合结束时一次性到达(无逐 token 流式),不支持手动上下文压缩;`authenticated_git`、`browser_use` 与 Agent 资源工具仅对 Codex 会话可用;MCP 服务器会注册全部工具,暂不应用应用侧的 MCP 工具白名单;Agent Plugins 贡献的技能/MCP 也仅对 Codex 会话生效。删除会话时会同时清理 DSH 原生历史与应用事件记录。

数据存储支持三种模式:`DATABASE_URL=sqlite:/path/to/cca.db` 使用内置 SQLite,`DATABASE_URL=h2:/path/to/cca.db` 是桌面本地模式使用的内置嵌入式数据库别名,`DATABASE_URL=mysql://...` 使用 MySQL;两者都会自动建表并从旧 JSON 文件迁移。未配置时继续使用 JSON 文件存储(默认 `~/.cloud-coding-agent`,可用 `CCA_DATA_DIR` 覆盖)。新会话在数据目录的 `codex-home/<会话 ID>/` 中保存原生历史、线程映射和应用事件,每个会话使用独立进程和 CODEX_HOME。配置 MySQL/SQLite 时,新会话消息、工具调用/结果及其时间戳写入 `thread_events` 表,按会话内序号读取,事件 ID 去重;写入串行分批提交。`cca-events.jsonl` 保留为故障补录日志,已有 Codex 会话在下次打开时自动补录,数据库故障会明确报错。未配置数据库时继续使用 JSONL。流式正文增量不逐 token 入库,完成消息保存全文;工具开始/完成事件保留参数、结果、状态和时间。Codex 原生状态仍用于续聊,数据库不能替代它,备份仍须覆盖数据库和数据目录。旧 `copilot-home/` 历史保留只读,不自动转换或续写;升级前应备份整个数据目录。旧 Copilot 默认模型会清空,请重新选择模型;连接器请重新选择非 Copilot 模型。

插件同样落在数据目录:安装的插件包在 `agent-plugins/<name>/`,每个插件的私有持久化目录在 `agent-plugin-data/<name>/`(作为 `PLUGIN_DATA` 传给插件的 MCP 子进程),安装记录与自定义市场源在 `agent-plugins.json`。插件安装时会校验清单、组件位置与包内路径边界,未知顶层字段只提示不拒绝;停用或卸载后对应技能与 MCP 立即从后续会话中移除。`skills/` 里由插件带来的技能是只读的,修改请改插件本身或卸载后自建。

## 本地开发

需要 Node.js 22.13 或更高版本。

```bash
npm install
npm run dev        # server :8787 + web :5173(代理 /ws)
```

## Desktop(macOS / Windows)

Electron 桌面版运行本地模式:关闭登录、注册和用户管理,使用 `userData/cca.db` 的内置嵌入式数据库,首次创建工作区时可通过原生文件夹选择器登记任意本地目录。数据和默认工作区保存在 Electron `userData` 目录;应用内启动同一个 Fastify 服务并使用随机的 `127.0.0.1` 端口。桌面进程设置 `BROWSER_BACKEND=electron-ipc`:每个会话使用独立、非持久化且沙箱化的 Electron `WebContentsView`,右侧浏览器面板显示该原生视图。请求会在服务子进程与 Electron 主进程之间通过受验证、限时的 IPC 转发;仅支持 `browser_use` 的固定操作,不提供任意 JavaScript。非桌面部署仍使用原有 Linux Xvfb/Chromium/noVNC 后端。

```bash
npm ci
npm run desktop          # 构建并启动未打包应用
npm run desktop:dir      # 生成可运行的未安装包,便于检查
npm run desktop:dist     # 当前平台生成 DMG/ZIP 或 NSIS 安装包
```

发布配置只构建当前主机架构。为覆盖 macOS Intel/Apple Silicon 与 Windows x64/arm64,请使用 `macos-*-x64`、`macos-*-arm64`、`windows-*-x64`、`windows-*-arm64` 四个原生 runner（可组成 CI matrix）,在每个 runner 上从干净目录执行 `npm ci && npm run desktop:dist`。不要在单个 runner 上用 `--x64 --arm64` 交叉打包。`node-pty`、Koffi、Codex 及兼容依赖的平台运行时保留在 ASAR 外;`npm ci` 会按构建主机安装对应可选平台包；`node-pty` 必须存在目标 OS/架构预编译文件（或在目标 runner 上安装编译工具后构建）。跨架构发布前请在每个目标架构的 runner 上执行并冒烟测试,不要复用其他平台的 `node_modules`。 浏览器网络策略会在顶层导航及 Electron 请求拦截阶段重新解析主机并拒绝本机、私网、链路本地和元数据目标（除非设置 `BROWSER_ALLOW_PRIVATE_NETWORK=true`）；这属于尽力过滤,不是 DNS pinning。正式发布还需配置 Apple Developer ID 签名/公证和 Windows Authenticode 证书;本仓库不会存放证书。产物写入 `release/`。

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

## 使用

1. 打开页面,使用管理员账户登录(开发 Compose 默认 `admin`/`admin123`;生产 Compose 使用 `.env` 中的配置),或注册普通账户
2. 左侧边栏「添加项目目录」→ 填服务器上的绝对路径
2. 设置 → 模型:添加一个 OpenAI 兼容服务(填 baseUrl、apiKey、模型列表;Responses 协议选 `openai-responses`)
3. 设置 → 通用:选择默认模型
4. 如需操作远程仓库,在设置 → 通用中使用具备仓库读写权限的访问令牌绑定 GitHub 或 Gitee
5. 回到首页,输入任务开聊;`@` 引用文件,`/` 选择技能
6. 设置 → MCP / 技能:按需接入平台级外部工具与提示词模块
7. Agent 可通过 `manage_mcp_servers` 和 `manage_skills` 查询或管理资源;workspace 写操作对工作区所有者开放,平台写操作仅管理员 Agent 可用。workspace 同名 MCP 覆盖平台配置

绑定令牌使用服务端密钥加密保存,按会话所属用户读取。Agent 通过受控的 `authenticated_git` 工具执行远程 Git 操作;令牌不会写入仓库 URL、`.gitconfig` 或 Web 终端环境。HTTPS 和常见 SSH remote 会统一通过对应平台的 HTTPS 认证执行。

### DSH 对话轨迹

新建会话时选择 DSH 执行引擎,进入会话后在顶部「对话 / 轨迹」中选择「轨迹」,即可查看时间线、轮次、模型请求和工具调用。点击记录可展开参数、结果、思考与计时详情,也可搜索、收起或展开轮次和调用、加载更早的历史。页面源码位于本仓库 `packages/dsh-ui-trajectory/src`,由 Web 的 Vite 构建直接编译进 `apps/web/dist` 的按需加载产物,无需单独的 DSH Web 页面或 iframe。

轨迹通过受会话权限保护的 `thread.trajectory.load` 读取当前会话的 DSH 原生持久日志,使用官方读取器处理压缩、日志代际和打包流记录。只有打开轨迹标签页才会每两秒检查版本并增量同步,版本未变时不重复解码;更早历史按需分页读取。SDK 文本仍在回合结束时到达,轨迹中的首 token、解码等计时来自最终日志保留的真实流时间戳。读取历史不会另起 Agent 进程。

`npm run build` 或 `npm run build:dsh` 会构建这份本地页面源码及样式。构建会确认轨迹组件来自本仓库,并输出来源及许可证到 `apps/web/dist/licenses/`。源码版本、适配边界和更新方式见 [轨迹源码说明](packages/dsh-ui-trajectory/README.md)。

### Codex 模型接入与兼容范围

推荐在「设置 → 模型服务」添加 OpenAI 兼容服务,Base URL 填 API 根路径(例如含 `/v1`),选择 `completions` 或 `responses`,再设置默认模型。Chat 上游必须支持 `stream: true` 和 function tool calling;网关转换文字、图片输入、推理增量、并行工具调用和工具结果,并把 Codex 的 free-form `apply_patch` 包装成带 `input` 字符串的 JSON 函数参数。兼容 Codex 的客户端 `tool_search`、搜索返回的 MCP 工具和命名空间调用。工具参数截断或流异常会报错,不会伪装成成功。手动压缩使用 Codex 的本地摘要流程,不伪造远程加密压缩结果。

图片生成通过 Codex 原生 MCP 工具通道注册 `cca_imagegen.image_gen`,新会话和恢复的旧会话均可发现并调用。仅当已配置的 OpenAI 提供商中存在 `gpt-image` 或 `gpt-image-*` 模型时启用;优先使用当前聊天提供商,否则按配置顺序选择第一个有 GPT Image 模型的提供商,并使用该提供商列表中第一个匹配的模型。生图通过所选提供商的 `/images/generations` 接口执行,使用服务端已有凭据,无需在运行环境配置额外的 `OPENAI_API_KEY` 或确认 CLI 回退;当前入口仅支持生成新图片。生成结果作为助手图片附件保存,支持聊天内预览、刷新恢复和 QQ 私聊/群聊/频道原生图片回传;单张图片限制 10 MB,计入现有图片存储额度。

不保证所有 OpenAI 兼容服务的扩展字段兼容;暂不支持依赖 `previous_response_id` 的服务端状态、原生 Anthropic、跨协议加密推理历史、Copilot CLI 插件市场和 Ultra 子代理模式。扩展请使用插件(Agent Plugins)、Skill 或 MCP 管理。自动提交信息通过自定义模型服务执行纯文本请求,不开放工具;原生 Codex 账号暂需手动填写提交信息。上游 API key 保留在服务端网关,子进程仅持有会话级随机网关凭证;本地网关不对外发布端口。

也可使用 Codex 原生账号:在运行服务的系统用户下,将 `CODEX_HOME` 指向 `$CCA_DATA_DIR/codex-home` 后,执行 `node node_modules/@openai/codex/bin/codex.js login`。服务会在打开会话时同步该目录的认证信息,不使用旧 Copilot 登录态。修改/清除认证后应重启服务以关闭旧会话。可通过 `CCA_CODEX_PATH` 指定同版本 Codex 可执行文件。请勿把认证文件放到项目工作区。
