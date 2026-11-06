# Docker 代码沙箱

Codex 和 DSH 共用 `cca_sandbox.run_code` MCP 工具。Agent 的模型调用和会话管理仍在 CCA 服务中运行；模型生成的 JavaScript 代码块（包括循环、条件、工具调用）通过 SSH 在远端 Docker 内执行。不会把 Markdown 展示中的代码自动当作命令执行。

```javascript
const results = [];
for (const file of ['src/a.ts', 'src/b.ts']) {
  const source = await tools.read_file(file);
  results.push({ file, lines: source.split('\n').length });
}
print(results);
print(await tools.exec('npm test', { timeout_ms: 120000 }));
```

工具参数：`code` 为 JavaScript async 函数体，`timeout_ms` 默认为 60000，范围 100～300000。提供 `tools.exec(command, {cwd?, timeout_ms?})`、`tools.read_file(path)`、`tools.write_file(path, content)`、`tools.list_files(path?)` 和 `print(value)`。命令返回 `stdout`、`stderr`、`exitCode`，需要在代码中自行检查失败退出码。

## 配置

远端需要 Linux、Python 3、Docker，并允许 SSH 用户运行 Docker。预先拉取镜像：

```bash
docker pull ghcr.io/converge-ai-labs/a13n-sandbox:0.3.0
```

在运行 CCA 的机器上执行（安装器需要 `pip install paramiko`，服务本身只需要系统 OpenSSH 客户端）：

```powershell
python deploy/docker-sandbox/install.py --host 192.168.100.130 --username nolaurence --data-dir "$env:USERPROFILE\.cloud-coding-agent"
```

安装器交互读取 SSH 密码，仅用于本次安装；不保存密码。生成专用 Ed25519 密钥、固定主机指纹、限制为网关命令的 `authorized_keys` 条目及 `docker-sandbox.json`。不会改动现有其他 SSH 密钥或容器。网关位于远端 `~/cca-code-sandbox/gateway.py`，每个会话的工作区位于 `~/cca-code-sandbox/workspaces/<hash>`。

CCA 默认读取 `<CCA_DATA_DIR>/docker-sandbox.json`（未设置 `CCA_DATA_DIR` 时为 `~/.cloud-coding-agent`），也可通过 `CCA_DOCKER_SANDBOX_CONFIG` 指定配置文件。内容示例：

```json
{
  "host": "192.168.100.130",
  "username": "nolaurence",
  "port": 22,
  "identityFile": "/data/sandbox-ssh/id_ed25519",
  "knownHostsFile": "/data/sandbox-ssh/known_hosts"
}
```

配置文件中的密钥路径必须是 **CCA 服务所在机器或容器中的绝对路径**。将 CCA 部署进 Docker 时，把配置和密钥放入现有 `/data` 卷，按上例修改路径；镜像已有 `openssh-client`。重新打开会话后配置生效。配置缺失保留原有本地模式；配置存在但无效、SSH 不通、镜像缺失时，会话启动报错，不回退本地执行。移走配置并重新打开会话可停用沙箱。

### 云效流水线部署

流水线使用 `Dockerfile_pipeline` 构建应用镜像，该镜像已包含 SSH 客户端并会编译本次沙箱接入代码。配置文件和私钥通过部署机器的持久化数据卷提供，无需放进 Git、构建上下文或镜像。

在部署环境的 `.env` 中设置以下路径；`docker-compose-prod.yml` 会将其传给应用。仅在镜像构建阶段设置该变量不会使运行中的服务获得配置。

```dotenv
CCA_DOCKER_SANDBOX_CONFIG=/data/docker-sandbox.json
```

`192.168.100.241` 已配置连接 `192.168.100.130` 的独立 SSH 密钥。文件位于现有 `cloud-coding-agent_agent-data` 卷中：`/data/docker-sandbox.json`、`/data/sandbox-ssh/id_ed25519` 和 `/data/sandbox-ssh/known_hosts`。公钥已在 `.130` 授权为仅运行沙箱网关，已验证 `.241` 到网关的连通性。

由流水线发布包含本次代码的镜像，并保留同一数据卷及上述运行时环境变量后，新建或重新打开会话即可启用。单独重启旧镜像不会增加沙箱功能。SSH 密码不需要传入流水线。

## 执行与文件

- 每个代码块一个临时容器，非 root，禁用额外 capabilities，启用 `no-new-privileges`，根文件系统只读，限制 2 CPU、2 GiB 内存、256 个进程。容器只挂载本会话的 `/workspace`，不挂载 Docker socket、SSH 密钥或服务数据。
- 执行结束、超时、取消均删除当次容器和其子进程。项目文件和远端依赖目录跨调用保留；JavaScript 内存、`/tmp` 和后台进程不保留。
- `full` 权限允许容器通过 bridge 网络访问外部服务；其他权限使用 `--network none`。容器资源限制不随权限提升而取消。
- Codex 禁用本地 shell、unified exec、JS REPL/code mode；DSH 禁用本地 shell、文件、工作流和子代理执行工具。已有其他 MCP/平台工具继续按其自身权限运行。
- 每次执行前同步项目普通文件，执行后同步新增、修改、删除及可执行位；二进制文件使用 base64。跳过符号链接以及 `.git`、`node_modules`、`.next`、`dist`、`build`、`coverage`、`.cache`、`__pycache__`。这些目录的本地内容不会上传，远端依赖可以通过 `tools.exec` 安装并保留。Git 元数据不同步，Git 操作使用平台已有入口。
- 同步上限为单文件 8 MiB、总计 64 MiB、10000 文件。输出总计最多 256 KiB，超过后终止容器。单次代码最多 256 KiB。大项目需选择较小工作区；构建产物不会自动回传，可复制需要交付的文件到未排除目录。
- 检测到本地编辑冲突时不覆盖变化的文件，完整结果保存在 `<CCA_DATA_DIR>/sandbox-recovery/<run>.json`，错误消息包含位置。远端导出失败会保留 `<hash>.dirty`，阻止下次执行覆盖未取回的结果；先从对应工作区恢复所需文件、处理超限文件，再删除该标记。
- 工作区目录在删除会话后仍保留，便于恢复；确认不再需要后由管理员清理。容器的资源限制不等同于持久工作区磁盘配额，远端需按部署要求配置磁盘配额和清理周期。

## 验证

默认 `npm test` 包含文件同步与边界检查；真实 Docker 和引擎集成测试需显式指定配置：

```powershell
$env:CCA_SANDBOX_INTEGRATION_CONFIG = "$env:USERPROFILE\.cloud-coding-agent\docker-sandbox.json"
node --import tsx --test apps/server/src/dockerSandbox.test.ts apps/server/src/dockerSandboxEngines.test.ts
```

集成测试使用真实 Codex/DSH 运行时和远端 Docker，模型响应由本地测试 HTTP 服务提供，不消耗模型额度。覆盖循环执行、文件回写、依赖保留、超时、取消、输出限制及两种引擎的工具发现和调用。
