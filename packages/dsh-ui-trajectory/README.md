# CCA DSH 轨迹页源码

本工作区保存从 DeepSeek Harness 直接引入的轨迹组件、事件投影、纯会话组装器、主题变量与中文词典。源版本及适配记录位于 `upstream.json`,许可证见 `LICENSE`。页面作为 CCA 原生会话的「轨迹」标签页显示。

在项目根目录运行:

```sh
npm run typecheck
npm run build:dsh
```

`apps/web` 从本工作区的 TypeScript 源码入口直接导入 `TrajectoryView` 与 `TrajectoryProjector`,Vite 将组件、事件定义、组装逻辑、CSS Modules 和词典编译为 `apps/web/dist/assets/DshTrajectory-*.js` 等按需加载产物。React 与 ReactDOM 通过 Vite dedupe 使用 CCA 已有实例。`ui-primitives` 是可直接打包的通用静态组件库;无需 Cordis GUI、模块加载器或 iframe。

构建插件检查输入图包含本工作区的 `TrajectoryView.tsx`,并拒绝导入 npm 的 `dsh-client-ui-trajectory` 页面。来源清单和许可证输出到 `apps/web/dist/licenses/`,随标准 Web/Docker 产物交付。

服务端的 `dsh/dshTrajectory.ts` 通过官方持久化读取器打开 `$CCA_DATA_DIR/dsh-home/<threadId>/sessions` 的原生日志。`thread.trajectory.load` 在读取前后验证会话权限,保留完整事件字段、`surfaceOp` 与打包流时间戳,支持前后分页及版本缓存。它不 attach 或启动 SDK 会话。

`DshTrajectory` 只在标签页挂载时按两秒间隔检查版本并合并新事件,切走或断线即停止。前端每个会话持有独立 `TrajectoryProjector`,以原版纯组装器重放/增量处理日志,生成包含 Map 和 location 数据源的本地 snapshot;该 snapshot 不经 JSON 传输。加载更早历史后重新投影完整窗口。

CCA 的适配只窄化组件数据属性、导出纯事件定义、调整组装器的类型引用并同步深色主题标识。系统提示词、请求头、工具与助手计时等投影保留上游逻辑。当前没有为轨迹图片 slot 注册图库,因此图片缩略图按上游约定省略,工具文本及原始事件详情仍可查看。

更新上游实现时,核对 `upstream.json` 所列源路径及本地适配,再执行类型检查、原生日志/投影测试和真实 DSH 会话的浏览器验证。
