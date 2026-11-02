# Kloud Work 原生客户端

Rust + GPUI + [Ely-GPUI-Components](https://github.com/ELY-Open-Source/Ely-GPUI-Components) 实现的原生桌面前端，界面完全由 Ely 的聊天与代理组件构成（`ChatContainer`/`MessageList`/`PromptInput`/`ToolCallCard`/`PermissionPrompt` 等）。默认连接 `https://agent.proxy.nolaurence.cn`。不包含 WebView，不启动本地服务、数据库、Codex 或 DSH；账号、工作区、会话、消息、模型与执行任务全部由云端 `apps/server` 管理，与网页数据完全一致。除服务地址设置、本地文件选择（附件上传）和在系统浏览器打开云端网页外，没有任何本地状态。

## 功能

- 用户名/密码登录，连接状态提示，退出并清除当前账号的内存状态。
- 云端工作区（`ProjectList`）与未归档会话列表（`ConversationList`，含置顶/删除），支持搜索；创建工作区、创建 Codex / DSH 会话。
- 新建会话时选择模型，使用标准模式和请求授权模式；DSH 的实际权限行为沿用服务端。
- 历史消息、Markdown 流式正文、思考过程（`ThinkingBlock`）与工具记录（`ToolCallCard`）；消息列表按可见区域渲染。
- 发送消息、停止任务、允许/拒绝权限请求（`PermissionPrompt`），只读分享会话禁用操作。
- 本地文件选择器挑选附件，先上传到云端附件库，再随消息发送（与网页附件链路一致）。
- 自动重连，重新订阅工作区列表和当前会话，以服务端快照恢复状态。
- 当前启动期间按会话保留草稿，跟随系统深浅色并可手动切换，在系统浏览器打开云端网页。

文件管理、上传下载、终端、Git 操作、交互式浏览器、Office 预览、插件和管理设置仍在网页使用；原生工具记录过长时只显示摘要。原生端不提供离线执行、跨设备草稿同步或长期本地缓存。

## 环境要求

- Rust **1.98+**（Ely 锁定提交的最低版本），Cargo；建议使用稳定工具链。
- Windows：MSVC C++ 构建工具及 Windows SDK。
- macOS：Xcode Command Line Tools。Ely 使用运行时 Metal shader，无需仅为此安装完整 Xcode。
- Linux：C/C++ 工具链、`pkg-config`、Fontconfig/Freetype、XKB、Wayland/X11 开发库，以及正常工作的图形驱动和桌面会话。
- 系统需有中文字体，例如 Windows 的微软雅黑、macOS 的苹方、Linux 的 Noto Sans CJK。

Debian / Ubuntu 开发依赖：

```sh
sudo apt-get install build-essential pkg-config libfontconfig1-dev libfreetype-dev \
  libxkbcommon-x11-dev libwayland-dev libxcb1-dev libegl1-mesa-dev libvulkan-dev \
  fonts-noto-cjk
```

## 运行与构建

在仓库根目录执行：

```sh
npm run desktop:native
npm run desktop:native:check
npm run desktop:native:build
```

也可以直接运行 `cargo run --manifest-path apps/desktop-gpui/Cargo.toml --locked`。首次构建需下载 Rust 依赖和锁定的 Ely 源码；现有 Node 服务端依赖不参与原生程序的运行。

发布模式可执行文件生成于 `apps/desktop-gpui/target/release/kloud-work`，Windows 为 `kloud-work.exe`。当前未生成安装包、签名、公证或自动更新配置；不要把未签名开发产物当作正式安装包。

登录页可以修改服务地址，也可通过 `CCA_SERVER_URL` 指定初始值：

```sh
CCA_SERVER_URL=http://127.0.0.1:8787 npm run desktop:native
```

仅本机回环地址允许 HTTP，远端必须使用 HTTPS。地址只能包含协议、主机和端口，不支持子路径部署。连接本机开发服务时，应启动普通账号登录模式的服务端。

## 数据与安全边界

- 密码和登录令牌仅保存在进程内存，不写配置文件、数据库或系统凭据库；关闭程序后需要重新登录。
- 登录请求不跟随重定向，防止把账号密码发送给其他地址；HTTP 与 WebSocket 均校验证书。
- WebSocket 使用当前服务端的 `/ws?token=...` 协议。原生程序不记录含凭据的 URL；反向代理也应避免记录 `/ws` 的完整查询串。
- 只自动恢复订阅，**不自动重发消息、建会话、创建工作区或授权操作**。断线/超时后应先确认云端结果，再决定是否重试，避免重复执行。
- 退出只关闭当前客户端连接，不发送停止任务指令。执行状态仍以服务端为准。
- 工作区、终端和命令路径都属于云端，不是当前电脑的本地路径。

## 协议与测试

`packages/protocol/src/index.ts` 仍是协议的单一事实来源。Rust 的 `src/protocol.rs` 只实现首版使用的子集；未知事件兼容忽略，已知事件字段不兼容时明确提示。

`packages/protocol/src/desktopFixtures.ts` 的样例受现有 TypeScript 类型检查约束，Rust 测试验证这些样例的解码和请求编码。修改协议时应同步 Rust 子集并重新生成样例，不要只修改 JSON：

```sh
npm run desktop:native:protocol
npm run typecheck
npm run test:desktop:native
```

网络和状态测试不需要图形环境，也不会访问线上业务账号：

```sh
cargo test --manifest-path apps/desktop-gpui/Cargo.toml --locked --no-default-features
```

自动化协议、网络和编译检查不等于桌面验收。发布前需要在目标系统的真实图形会话中确认中文输入法、Markdown、流式消息行高、滚动、窗口缩放、权限弹窗和断线恢复；再使用自己的账号验证网页与原生端能互相看到新建会话和消息。无头 Xvfb / 软件 Vulkan 环境不作为图形兼容性通过的依据。

覆盖登录失败、重定向保护、会话失效、连接关闭、重连订阅恢复、不重发变更操作、快照恢复、消息去重、权限事件和协议兼容。完整原生界面仍需在目标操作系统验证中文输入法、字体回退、长消息滚动和图形驱动。

## 依赖维护

Ely 当前仍为早期不稳定库，因此锁定 Git 提交 `01fe68db06998203184ccf6da8de50f7cae2b628`，GPUI 固定为该提交使用的 `gpui-pre = 0.3.10`，并提交 `Cargo.lock`。只使用 Ely 的 core、chat、agent、documents 模块，不引入无关业务组件。升级时应成套验证，避免跟随 `main` 自动变更。

Ely 使用 MIT 许可，图标与字体另有第三方许可；打包分发时应随产物保留所用依赖、图标及字体的许可声明。
