## codex 建议
当前是 docker-compose-standalone.yml 部署，更新代码后在项目目录执行：

  cd /root/agent/cloud-coding-agent

  # 确认没有未保存的本地修改
  git status

  # 拉取代码
  git pull --ff-only

  # 更新依赖并检查类型
  npm ci
  npm run typecheck

  # 重新构建镜像并替换容器
  docker compose -f docker-compose-standalone.yml up -d --build

  # 检查状态和日志
  docker compose -f docker-compose-standalone.yml ps
  docker compose -f docker-compose-standalone.yml logs --tail=100 agent

  这个过程不会删除 cloud-coding-agent_agent-data，数据库、项目配置和用户数据都会保留。不要加 -v，也不需要先执行 down。

  只修改 .env 时可执行：

  docker compose -f docker-compose-standalone.yml up -d --force-recreate

  但 ADMIN_PASSWORD 是例外：已有管理员密码存在数据库中，修改 .env 后仍需像刚才那样重置密码。其他环境变量会随容器重建生效。

  另外，你当前 docker-compose-standalone.yml 有一个“文件末尾缺少换行”的本地改动。拉代码前建议先看：

  git diff -- docker-compose-standalone.yml

  确认不需要后再还原或提交，避免将来拉取时产生冲突。

## 镜像层解压失败（`UtimesNanoAt ... /app/node_modules/.bin`）

`Some service image(s) must be built from source` 是 Compose 拉取失败后的提示；
真正的错误发生在 Docker/containerd 解压镜像层时，应用尚未启动。
仅重启容器或再次拉取同一个镜像 tag 不会重新构建出错的镜像层。

Dockerfile 将 DSH/pnpm 安装放在应用目录之外，并在所有安装完成后复制应用，
避免后续安装层改写 `/app/node_modules`。构建上下文也排除了所有层级的
`node_modules`，应用依赖由容器内的 `npm ci` 安装。

拉取包含修复的代码后，在部署机上重新构建并启动：

```bash
docker compose -f docker-compose-standalone.yml build --pull --no-cache agent
docker compose -f docker-compose-standalone.yml up -d --no-build --pull never agent
docker compose -f docker-compose-standalone.yml ps
docker compose -f docker-compose-standalone.yml logs --tail=100 agent
```

如果使用 `docker-compose-prod.yml` 或 `docker-compose.release.yml`，将上面的
文件名替换为对应配置；这些配置还要求 `.env` 中设置 `CCA_IMAGE`。
如果通过镜像仓库发布，需要在构建机重新构建、推送一个新 tag，再让部署机拉取新 tag；
修改部署机上的 Dockerfile 不会改变仓库里已经发布的镜像。

若全新构建的镜像仍在解压阶段失败，记录 `docker version`、`docker info`、
`containerd --version` 和出错的镜像摘要，继续排查部署机的 containerd/overlayfs。
上述操作保留 `agent-data` 数据卷；无需执行 `down -v` 或清理 Docker 数据目录。

## DeepSeek Harness 启动失败

源码镜像和 `Dockerfile_pipeline` 现在通过同一安装脚本内置 DSH、web profile、
SSH helper 和 rsync。旧流水线镜像没有这些文件，需要重新构建并发布新 tag 后部署；
只刷新页面不会补装运行时依赖。

服务端同时把 `@deepseek-ai/dsh` 和 `@deepseek-ai/dsh-sdk-client` 作为
`apps/server` 的生产依赖安装，用于 `/dsh/` 的官方 host 和 `/api/agent/run`
的 SDK 运行时。镜像重新构建后会同时存在全局 DSH（profile/helper）与
`/app/node_modules` 里的本地 DSH；`src/dshManager.ts` 优先使用后者，
`DSH_BIN` 仍可显式覆盖。

## DSH Web 外壳与本地 UI 插件

`apps/dsh-web` 是搬入本仓库的 DSH Web 外壳源码。镜像构建会执行
`npm run build -w @cca/dsh-web`，产出：

- `apps/dsh-web/dist/`：外壳 HTML 和静态资源，由服务端在 `/dsh/` 提供；
- `apps/dsh-web/plugins/<name>/lib/`：`sidebar`、`brand` 的 DSH client bundle。

服务端会从当前用户的 `dsh web` 取回 index.html，把 `__DSH_BOOT__`、插件预加载
和主题初始化注入外壳，再代理 `/dsh/plugins/*`、`/dsh/api/*` 和
`/dsh/api/remote.mux`。因此不能再把 `/dsh/` 当成静态目录直接挂载，也不要在
前置 Nginx 上剥离 `/dsh` 前缀。

可用环境变量覆盖默认路径：

- `CCA_DSH_WEB_DIR`：外壳 `dist` 目录（默认 `apps/dsh-web/dist`）；
- `CCA_DSH_UI_PLUGINS`：本地 UI 插件根目录（默认 `apps/dsh-web/plugins`）。

登录页在 `/login`（未登录时任意路径都会显示登录页），管理员设置保留在
`/settings`；登录成功后整页跳转到 `/dsh/`，不再使用 iframe，也不再渲染
CCA 左侧 NavRail。DSH 侧边栏底部的「设置 / 退出」
由 `apps/dsh-web/plugins/sidebar` 注册：设置跳 `/settings/general`，退出跳
`/logout` 并调用 `/dsh/logout` 撤销 portal cookie（`/api/dsh/logout` 保留给
API 客户端）。

`deploy/dsh/patch-brand.mjs` 仍然负责去掉官方 host 自带的 conversation hero /
预览说明等品牌文本；侧边栏 logo 和字标已由本地 `brand` 插件接管。

启动失败时，页面和容器日志会保留具体原因（如缺少 SSH helper、沙箱私钥、
profile 模板或模型提供方）。修复配置或挂载文件后会自动重试，也可以点击页面
“重试”立即重新检查；该操作不会重启已就绪或正在启动的 DSH 进程。

## 用户工作区与 DSH 数据

DSH 按登录用户启动独立进程，数据保存在
`$DSH_HOME/users/<用户名的 SHA-256>/`，分别保存工作区、会话和 DSH 配置。
工作区目录根据 CCA 项目的 `ownerId` 筛选，管理员也不会默认获得其他用户的
DSH 工作区。项目归属、新增或移除发生变化时，对应用户的实例会重新加载。
默认“个人工作区”指向 `/workspace/.cca-users/<用户摘要>/`，不再暴露公共 `/workspace` 根目录。

升级前的共享 `$DSH_HOME/storages/` 保持原样，不会自动复制到任何用户目录。
原有 CCA 项目目录不移动；新实例按原项目所有者加载目录。
旧共享 DSH 会话没有可靠的用户归属记录，因此不会自动分配，以免把其他用户的历史展示出来。
备份时请保留整个 `DSH_HOME`，包括旧共享目录和新的 `users/`。

HTTP、WebSocket 和登录凭据均绑定到当前用户的 DSH 实例，切换账号会撤销
当前浏览器原账号的 DSH 代理会话。SSH 网关和远程容器仍使用现有部署配置；
这里隔离的是用户的 DSH 进程、目录索引和会话数据，不会为每个用户创建独立远程容器。
