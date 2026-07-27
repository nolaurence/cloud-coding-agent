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