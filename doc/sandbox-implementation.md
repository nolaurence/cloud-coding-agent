# Copilot 工作区 Sandbox 实现解析

本文解析服务端当前的 Copilot 工作区 Sandbox 实现，覆盖会话级运行时策略注入、工具权限回调、工作区路径校验、应用层配套防护、测试覆盖以及维护时需要注意的边界。

> 本文中的 “Sandbox” 专指由 `CopilotManager` 创建或恢复的模型会话。应用内的用户终端、浏览器进程和普通 WebSocket 文件接口有各自的权限与路径校验，不自动继承 Copilot 会话的文件系统沙箱。

## 1. 目标与保护范围

当前实现希望保证每个 Copilot 会话只围绕其关联项目工作：

- 当前项目目录是该会话唯一声明的可读写工作区。
- 服务端数据目录 `DATA_DIR` 被显式拒绝，避免模型接触账号、密钥、设置和会话状态。
- Store 中除当前项目外的所有项目路径被显式拒绝，不因项目所有者相同而放宽。
- 读、写和 Shell 权限请求再次检查目标路径是否位于当前工作区。
- 任何 `requestSandboxBypass` 请求都会被拒绝。
- MCP、Memory、Hook、扩展和未允许的自定义工具采用默认拒绝策略。
- 创建新会话、恢复旧会话和生成 Git 提交信息的临时会话都经过同一个注入入口。

这套实现主要应对模型误操作、提示词注入诱导和工具参数越界。它不是完整的主机、容器或网络隔离方案，也不替代各业务接口自身的鉴权与输入校验。

## 2. 整体架构

Sandbox 不是一个单独开关，而是几层约束共同工作：

```text
WebSocket 请求
      │
      ├── Hub 校验用户、会话和项目归属
      │
      ▼
CopilotManager.buildSessionConfig()
      ├── workingDirectory = 当前项目路径
      ├── onPermissionRequest = 工作区权限处理器
      ├── 关闭 MCP / Skills / Plugins / Hooks / Memory 等能力
      └── 只注册应用允许的自定义工具
      │
      ▼
SDK createSession() / resumeSession()
      │
      ▼
connection.sendRequest() 包装器
      └── 向 session.create / session.resume 注入 sandboxConfig
              ├── readwritePaths = 当前项目路径
              └── deniedPaths = DATA_DIR + 其他所有项目路径

模型发起工具调用
      ├── Copilot 运行时执行 sandboxConfig
      └── PermissionHandler 逐次批准或拒绝请求

应用自定义工具 / WebSocket 文件接口
      └── 各自在服务端执行归属、路径、凭据或 URL 校验
```

这里有三个不同性质的安全控制：

1. `sandboxConfig` 是交给 Copilot 运行时执行的文件系统限制。
2. `PermissionHandler` 是会话工具调用的应用级授权决策。
3. Hub 和各业务模块的校验保护应用自己的服务端接口与自定义工具。

系统提示词中的“只能访问当前工作区”只是行为引导，不应被视为安全边界。

## 3. 关键文件

| 文件 | 职责 |
| --- | --- |
| `apps/server/src/sandbox.ts` | 构造 `sandboxConfig`，包装 SDK RPC 连接并在创建/恢复会话时注入策略 |
| `apps/server/src/permissions.ts` | 创建逐会话权限处理器，校验读、写、Shell、URL 和自定义工具请求 |
| `apps/server/src/copilot.ts` | 绑定会话与项目、安装 Sandbox、收缩会话能力并创建/恢复 SDK 会话 |
| `apps/server/src/hub.ts` | 在进入 Copilot、文件、Git 和终端操作前校验用户、会话和项目归属 |
| `apps/server/src/workspace.ts` | 普通工作区文件接口的真实路径、符号链接、文件大小和并发版本校验 |
| `apps/server/src/workspaceProjects.ts` | 在统一工作区根目录下创建用户项目并记录所有者 |
| `apps/server/src/uploads.ts` | 校验上传图片和工作区附件的归属及真实路径 |
| `apps/server/src/gitOperations.ts` | 对认证 Git 工具执行目标路径、环境变量和凭据保护 |
| `apps/server/src/browser.ts` | 对浏览器导航执行协议、DNS 和私网地址检查 |
| `apps/server/src/terminals.ts` | 管理用户终端及其环境；不属于 Copilot 会话 Sandbox |
| `apps/server/src/sandbox.test.ts` | 验证策略构造和 RPC 注入行为 |
| `apps/server/src/permissions.test.ts` | 验证权限矩阵和路径逃逸防护 |
| `apps/server/src/copilot.test.ts` | 验证完整会话配置、实际 RPC 参数及跨项目拒绝列表 |

## 4. 为什么在 RPC 层注入

项目声明依赖 `@github/copilot-sdk@^1.0.8`。底层 Copilot RPC Schema 包含 `SandboxConfig`，但 SDK 的公开 `SessionConfig` 没有暴露这个字段，并且 SDK 会在创建或恢复会话时重新组装 RPC 参数，普通配置中的未知字段会被丢弃。

因此，直接给高层 Session Config 增加一个 `sandboxConfig` 或 `sandbox` 属性不能可靠地下发到运行时。当前实现采用兼容层：在 SDK 启动后包装其运行时可访问的内部连接，在最终 JSON-RPC 请求发出前补上配置。

`CopilotManager.ensureClient()` 的顺序是：

1. 创建 `CopilotClient`。
2. 调用 `client.start()`，等待内部连接建立。
3. 调用 `installWorkspaceSandbox(client, workspaceSandboxDeniedPaths)`。
4. 只有安装成功后才把客户端保存为可复用实例。

`installWorkspaceSandbox()` 保存原始 `connection.sendRequest`，再用包装函数替换它。包装函数只处理：

- 方法名为 `session.create` 或 `session.resume`。
- `params` 是对象。
- `workingDirectory` 是非空字符串。
- 请求中尚未显式提供 `sandboxConfig`。

其他 RPC、缺少有效工作目录的请求和已有显式 Sandbox 配置的请求都会原样转发。调用原方法时使用 `original.call(connection, ...)`，保留原连接对象作为 `this`。

如果升级后的 SDK 不再暴露 `connection.sendRequest`，安装过程会直接抛出“无法启用工作区沙箱”，而不是静默退化为无 Sandbox 运行。

## 5. 运行时文件系统策略

`buildWorkspaceSandboxConfig()` 生成的配置形状如下：

```ts
{
  enabled: true,
  addCurrentWorkingDirectory: true,
  userPolicy: {
    filesystem: {
      readwritePaths: [workspacePath],
      deniedPaths: [DATA_DIR, ...otherWorkspacePaths],
    },
  },
}
```

### 5.1 当前工作区

会话配置中的 `workingDirectory` 来自 `thread.projectId` 对应的项目路径。构建配置前会确认：

- 会话关联的项目仍然存在。
- 会话有所有者。
- 项目所有者与会话所有者相同。

当前项目路径同时出现在 `workingDirectory` 和 `readwritePaths` 中，`addCurrentWorkingDirectory` 也保持开启。这看起来有重复，但符合当前运行时配置的约定：工作目录负责会话上下文，文件系统策略显式声明允许的读写根目录。

### 5.2 拒绝路径

`workspaceSandboxDeniedPaths(workspacePath)` 每次收到创建或恢复会话 RPC 时读取当前 Store，并返回：

1. 服务端 `DATA_DIR`。
2. Store 中所有路径不等于当前工作区的项目。

`buildWorkspaceSandboxConfig()` 随后：

- 使用 `Set` 去重。
- 即使上游误把当前工作区放入拒绝列表，也会将其移除。
- 不按所有者过滤其他项目，因此同一用户的多个项目之间也保持隔离。

拒绝列表是在 `session.create` 或 `session.resume` 时生成的策略快照。会话运行期间新登记的项目不会自动写回已有会话的配置；该会话下次恢复时才会重新计算。

## 6. 权限回调

`buildSessionConfig()` 为每个会话设置：

```ts
onPermissionRequest: createWorkspacePermissionHandler(project.path)
```

权限处理器创建时先对工作区执行 `fs.realpathSync()`，固定真实根路径。工作区不存在或无法解析时会立即失败，不会创建一个基于无效路径的处理器。

所有成功结果均为 `approve-once`，不会为后续请求保存永久批准。

| 请求类型 | 批准条件 | 拒绝情况 |
| --- | --- | --- |
| 任意类型 | 没有请求 Sandbox bypass | `requestSandboxBypass: true` 时优先拒绝 |
| `read` | `request.path` 位于当前工作区 | 目标越界、真实路径解析失败或通过符号链接逃逸 |
| `write` | `request.fileName` 位于当前工作区 | 目标越界、父目录真实路径越界或解析失败 |
| `shell` | 所有 `possiblePaths` 均位于当前工作区 | 任一候选路径越界 |
| `custom-tool` | `toolName === "authenticated_git"` | 其他自定义工具默认拒绝 |
| `url` | 未请求 bypass | bypass 请求会在前置规则中拒绝 |
| 其他类型 | 无 | MCP、Memory、Hook、扩展管理和扩展权限等默认拒绝 |

### 6.1 路径判定

`isWorkspacePath()` 同时做词法检查和真实路径检查：

1. 使用 `path.resolve(workspaceRoot, target)` 得到绝对目标。
2. 使用 `path.relative()` 确认目标等于根目录或位于根目录之下，拦截绝对路径和 `../` 逃逸。
3. 如果目标尚不存在，逐级向上找到最近的已存在祖先。
4. 对该目标或祖先执行 `fs.realpathSync()`。
5. 再次确认真实路径位于工作区真实根目录内。

第 3 步使新文件写入也能防御符号链接逃逸。例如，`workspace/link/new.txt` 虽然词法上位于工作区，但如果 `link` 指向外部目录，其最近存在祖先的真实路径会越界，因此请求被拒绝。

### 6.2 Shell 的特殊情况

Shell 请求依赖 SDK 给出的 `possiblePaths`：

- 列表非空时，所有路径都必须通过工作区检查。
- 列表为空时，处理器以工作区根目录作为目标并批准请求。

因此，权限层对 Shell 的覆盖程度取决于 SDK 的命令分析结果。对于无法提取路径的命令，底层运行时 Sandbox 是防止文件系统越界的重要约束。

## 7. 会话能力收缩

除文件系统策略和权限回调外，`buildSessionConfig()` 还主动关闭不需要的动态能力：

```ts
enableConfigDiscovery: false
requestExtensions: false
mcpServers: {}
customAgents: []
skillDirectories: []
pluginDirectories: []
enableSkills: false
enableFileHooks: false
memory: { enabled: false }
enableSessionStore: false
skipEmbeddingRetrieval: true
embeddingCacheStorage: "in-memory"
```

这样做减少了会话从工作区外加载配置、扩展、MCP、Skill、Plugin、Hook、Memory 或持久化 Session Store 的入口。权限处理器仍然默认拒绝对应请求，形成配置关闭与运行时授权两层约束。

应用显式注册的工具只有：

- `authenticated_git`：使用当前用户已绑定的 GitHub/Gitee 凭据执行认证 Git 操作。
- `browser_use`：使用线程级浏览器执行导航和页面交互。

“已注册”不等于绕过权限或业务校验。`custom-tool` 权限请求只显式批准 `authenticated_git`；浏览器导航还会在 `browser.ts` 中执行独立 URL 安全检查。

当前两个工具都没有设置 `skipPermission: true`。按 SDK 的 Tool 类型契约，这表示工具不主动跳过权限请求；如果运行时为 `browser_use` 发出 `custom-tool` 权限请求，当前处理器会在进入浏览器 Handler 前拒绝它。现有测试只验证工具被注册以及 URL 校验逻辑，没有覆盖 Agent 端到端成功调用 `browser_use`。因此这是一个需要结合当前 Copilot 运行时确认并统一的权限配置不一致，而不是浏览器 URL 校验已经解决的问题。

系统消息还会要求模型仅访问当前工作区且不得请求绕过 Sandbox。该消息可以改善模型行为，但真正的强制边界仍是运行时策略、权限回调和服务端校验。

## 8. 会话生命周期中的覆盖

### 8.1 普通对话会话

附加线程时，服务端根据是否存在历史记录选择：

1. 有历史时尝试 `client.resumeSession(threadId, config)`。
2. 恢复失败或没有历史时调用 `client.createSession(config)`。

两者最终分别发送 `session.resume` 和 `session.create`，都在 Sandbox 包装器的处理范围内。

### 8.2 Git 提交信息会话

AI 生成提交信息会创建一个临时 Session，并把 `tools` 和 `availableTools` 清空。它仍然通过 `buildSessionConfig()` 和同一个 Copilot Client 创建，因此同样会获得：

- 当前项目 `workingDirectory`。
- 工作区权限处理器。
- RPC 层 `sandboxConfig`。
- 会话能力收缩配置。

这避免了辅助型模型调用成为绕过主会话隔离的另一条路径。

## 9. 应用层的配套防护

Copilot Sandbox 只约束 SDK 会话发起的操作。应用自身暴露的 WebSocket API、自定义工具和用户终端仍需要单独保护。

### 9.1 Hub 归属校验

`hub.ts` 在处理操作前通过两类方法校验权限：

- `requireOwnedProject()`：项目必须属于当前登录用户。
- `requireOwnedThreadProject()`：会话必须属于当前用户、关联请求中的项目，且项目也属于当前用户。

启动 Turn 时还会校验会话与项目归属以及附件。文件读取、文件写入、Git 操作和终端打开各自使用相应的所有者检查。前端隐藏按钮或传入 `projectId` 不是安全边界。

### 9.2 项目和文件路径

`workspaceProjects.ts` 在统一 `WORKSPACE_ROOT` 下使用 UUID 目录创建项目，将目录权限设置为 `0700`，保存真实路径并记录 `ownerId`。

`workspace.ts` 对普通文件 API 另做防护：

- 拒绝空路径、绝对路径和包含 NUL 的路径。
- 通过词法路径和 `realpathSync()` 防止越出工作区。
- 列目录时跳过符号链接及常见生成目录。
- 写文件时拒绝符号链接，并检查内容大小、UTF-8 和内容版本。
- Git 根目录只允许项目根或真实的一级子目录，不接受符号链接目录。

这些检查保护的是应用文件面板和 Git 面板，不应因已有 Copilot Sandbox 而删除。

### 9.3 附件

`uploads.ts` 分别校验两类附件：

- 上传图片必须位于当前用户名对应的上传目录，并符合服务端生成的 ID 规则。
- 工作区附件会解析真实路径，必须位于当前项目内且是普通文件。

### 9.4 认证 Git 工具

`authenticated_git` 之所以能被权限处理器允许，是因为它在自己的处理器中继续执行约束：

- `clone` 目标必须是当前项目下的相对子路径。
- 目标父目录和已存在目标都会通过真实路径检查，防止符号链接逃逸。
- Git 子进程使用清理后的环境变量。
- 访问令牌只临时注入认证流程，并在输出和错误中脱敏。

自定义工具运行在服务端进程中，不能假设它自动受 Copilot 文件系统 Sandbox 保护，因此这类独立校验是必需的。

### 9.5 浏览器工具

`browser.ts` 的网络策略与工作区文件系统 Sandbox 相互独立。默认情况下，`assertSafeBrowserUrl()` 只接受 HTTP(S)，禁止 URL 内嵌凭据，并结合 DNS 解析拒绝回环、私网和云元数据地址。只有显式设置 `BROWSER_ALLOW_PRIVATE_NETWORK=true` 才会放宽私网限制。

Chromium 启动参数中的 `--no-sandbox` 指浏览器进程自身的 Chromium Sandbox，与本文的 Copilot 工作区 Sandbox 不是同一机制。工作区文件隔离不能替代浏览器 URL/网络校验。

### 9.6 用户终端

`terminals.ts` 将终端工作目录设为项目路径，使用环境变量白名单，并把 `HOME` 和 `USERPROFILE` 指向该项目目录；Hub 也会校验终端所有者。

但是，这个终端是用户直接操作的系统 Shell，不经过 Copilot Session 的 `sandboxConfig` 或 `PermissionHandler`。当前实现不应被描述为对用户终端提供了 OS 级文件系统隔离。

## 10. 测试覆盖

### 10.1 `sandbox.test.ts`

覆盖以下行为：

- 当前工作区进入 `readwritePaths`。
- 拒绝路径去重并移除当前工作区。
- `session.create` 和 `session.resume` 都注入配置。
- 其他 RPC 和无效 `workingDirectory` 不注入。
- 已有显式 `sandboxConfig` 不被覆盖。
- SDK 内部连接不可用时抛错。

### 10.2 `permissions.test.ts`

覆盖以下行为：

- 工作区内读、写和无候选路径 Shell 请求获批。
- 工作区外的绝对路径、相对路径和 Shell 路径被拒绝。
- 已存在文件及尚未创建文件的符号链接逃逸被拒绝。
- 所有 Sandbox bypass 请求被拒绝。
- MCP、Memory、Hook、扩展及未注册工具默认拒绝。
- `authenticated_git` 和不请求 bypass 的 URL 获批。
- 不存在的工作区根目录无法创建权限处理器。

在 Windows 无权限创建符号链接时，符号链接用例会跳过；实现本身仍执行真实路径检查。

### 10.3 `copilot.test.ts`

集成层测试验证：

- 会话使用项目路径作为 `workingDirectory`。
- 权限回调和所有能力收缩选项被写入配置。
- 实际 `session.create` RPC 收到完整 `sandboxConfig`。
- `deniedPaths` 包含 `DATA_DIR` 和其他项目路径。
- 其他项目即使属于当前用户也不会从拒绝列表中移除。
- 会话所有者与项目所有者不匹配时拒绝创建配置。

仓库测试命令为 `npm test`，全 workspace 类型检查命令为 `npm run typecheck`。

## 11. 已知边界与维护风险

### 11.1 依赖 SDK 内部结构

RPC 注入使用公开类型没有承诺的 `client.connection.sendRequest`。这是为了补足当前 SDK 高层配置缺口的有意兼容实现，但 SDK 升级可能改变属性名、调用时机或请求形状。升级 `@github/copilot-sdk` 或 `@github/copilot` 时必须复测真实创建和恢复请求，不能只依赖 TypeScript 编译通过。

### 11.2 运行时语义由 Copilot CLI 提供

本仓库负责构造并下发策略，底层如何在不同操作系统执行文件系统 Sandbox 由 Copilot 运行时决定。`readwritePaths` 和 `deniedPaths` 的平台行为发生变化时，需要结合目标 Windows/Linux 环境验证。

### 11.3 没有统一网络 Sandbox

当前 `sandboxConfig.userPolicy` 只显式配置文件系统，没有声明统一的网络策略；权限处理器也允许不请求 bypass 的 `url` 请求。浏览器私网防护和认证 Git 的远程访问限制属于各工具自己的边界。

### 11.4 Shell 路径分析不是完备解析器

权限处理器使用 SDK 的 `possiblePaths`，列表为空时会批准。因此不能只依赖权限回调判断任意命令的全部文件访问，必须保留运行时文件系统 Sandbox。

### 11.5 策略是会话级快照

拒绝路径在创建或恢复时计算。运行中的会话不会因 Store 后续新增项目而实时更新；新项目会在下一次创建或恢复时进入拒绝列表。当前工作区仍是唯一声明的 `readwritePaths`，但显式拒绝列表本身并非动态订阅。

此外，`workspace.remove` 当前只调用 `store.removeProject()` 删除项目记录，不删除项目磁盘目录。该目录会立刻从后续创建或恢复会话的 `workspaceSandboxDeniedPaths()` 来源中消失。它是否仍可被读取取决于 Copilot 运行时的基础策略，因此删除工作区时应考虑同步处理磁盘目录，或继续跟踪需要拒绝的已移除路径。

### 11.6 显式配置不会被覆盖

注入器发现请求已有 `sandboxConfig` 时会保留它。正常应用路径不会主动提供该字段，但未来如果增加底层 RPC 调用方，必须避免传入关闭或放宽隔离的显式配置，或者在评审后调整这条保留规则。

### 11.7 浏览器工具权限配置需要统一

`browser_use` 已加入 Session 的工具列表，但没有设置 `skipPermission: true`，而 `PermissionHandler` 对 `custom-tool` 只允许 `authenticated_git`。若当前运行时按 SDK 契约为浏览器工具发出权限请求，浏览器调用会被拒绝。维护时需要明确选择由权限处理器允许 `browser_use`，还是采用其他经过评审的授权方式，并补充端到端调用测试；无论如何都必须保留浏览器 Handler 内的 URL 安全检查。

### 11.8 服务端工具需要自行校验

运行在应用进程中的自定义工具、文件 API、Git API、浏览器和用户终端不应假设被会话 Sandbox 自动包裹。新增工具时应明确其信任边界，并为路径、URL、凭据和所有者分别做服务端校验。

## 12. 修改时的检查清单

涉及 Sandbox 或新工具的变更至少应检查：

1. 创建和恢复会话是否仍携带相同的 `sandboxConfig`。
2. 当前工作区是否只进入 `readwritePaths`，且没有误入 `deniedPaths`。
3. `DATA_DIR` 和所有其他项目是否进入拒绝列表。
4. 新 Permission Request 类型是否应显式允许；未决定时保持默认拒绝。
5. 新自定义工具是否有独立的路径、网络、凭据和用户归属校验。
6. 是否存在符号链接、`../`、绝对路径或未创建目标的逃逸路径。
7. 是否把行为提示、浏览器 `--no-sandbox` 或用户终端错误地当成工作区安全边界。
8. 工具注册、`skipPermission` 与 `custom-tool` 权限白名单是否一致。
9. SDK 升级后内部连接和 RPC Schema 是否仍匹配。
10. `npm test` 与 `npm run typecheck` 是否通过。

## 13. 总结

当前实现的核心是“双重会话约束”：RPC 层为每个创建或恢复的 Session 注入文件系统策略，权限层对每次工具请求做工作区范围和能力类型判断。Hub、工作区文件模块、认证 Git 和浏览器再为服务端入口补上独立校验。

真正需要长期维护的关键点不是系统提示词，而是 SDK 内部 RPC 注入兼容性、Shell 路径分析的局限、会话级拒绝路径快照，以及所有服务端自定义工具必须继续承担自己的安全校验。
