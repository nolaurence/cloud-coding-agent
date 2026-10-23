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
