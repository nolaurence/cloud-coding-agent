# CCA DSH 轨迹页源码

本工作区保存从 `deepseek-harness/packages/client/ui-trajectory/src` 直接复制的页面源码,包含 TS/TSX 组件、事件投影、时间线、搜索和 CSS Modules。源版本与许可证记录在 `upstream.json`、`LICENSE` 中。源码文件保持上游实现,CCA 的加载与构建适配位于工作区外。

在项目根目录运行:

```sh
npm run build:dsh
npm run typecheck
```

`scripts/build-dsh-trajectory.mjs` 使用 esbuild 与 lightningcss 从本工作区的源码生成 `apps/server/dist/dsh-ui-trajectory/`。产物包含:

- `client.js`、`client.js.map`:轨迹页代码、样式、diff 实现和纯工具代码构成的浏览器 bundle。
- `index.js`、`package.json`:DSH 加载本地产物所需的 Host 入口与模块元数据。
- `bundle-meta.json`:实际参与 bundle 的源码输入与共享模块清单。
- `LICENSE`、`THIRD_PARTY_LICENSES.txt`、`upstream.json`:随产物交付的许可证与源版本记录。

构建会校验 `TrajectoryView.tsx` 来自本工作区,并拒绝把 npm 的 `@deepseek-ai/dsh-client-ui-trajectory` 作为页面输入。React、虚拟列表和 DSH 的通用 UI 基础模块使用 iframe 提供的同一运行时实例;组件、事件处理、样式和本地化字典则直接编译进本地产物。

服务端标准构建和开发启动会自动构建本工作区。CCA overlay 关闭发行包自带的 `ui-trajectory`,以 `cca-ui-trajectory` 加载本地产物的 file URL。缺少本地产物时会提示构建命令,不会回退到 npm 页面。云端 Docker 镜像随服务端 `dist` 一起包含该目录,运行时无需访问 sibling deepseek-harness 仓库。

更新上游实现时,从确定版本复制 `src/`,更新 `upstream.json`,再执行类型检查、构建和真实 DSH 页面验证。修改源码后需重新构建并重启服务以重新加载 DSH 插件。
