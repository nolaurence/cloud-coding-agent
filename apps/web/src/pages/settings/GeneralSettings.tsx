import { useApp } from "../../lib/store";
import { ModelPicker } from "../../components/ModelPicker";
import { Button, Switch } from "../../components/ui/primitives";

export function GeneralSettings() {
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const dark = document.documentElement.classList.contains("dark");

  if (!settings) return null;

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-3 text-base font-semibold">外观</h2>
        <div className="flex items-center justify-between rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div>
            <div className="text-sm">深色模式</div>
            <div className="text-xs text-zinc-500">切换界面明暗主题</div>
          </div>
          <Switch
            checked={dark}
            onChange={(v) => {
              document.documentElement.classList.toggle("dark", v);
              localStorage.setItem("cca-theme", v ? "dark" : "light");
            }}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold">默认模型</h2>
        <div className="flex items-center justify-between rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div>
            <div className="text-sm">新会话默认使用的模型</div>
            <div className="text-xs text-zinc-500">可在「模型」页添加 OpenAI / OpenAI Responses 协议的服务</div>
          </div>
          <ModelPicker
            value={settings.defaultModel}
            onChange={(ref) => void updateSettings({ ...settings, defaultModel: ref })}
          />
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold">运行环境</h2>
        <div className="rounded-lg border border-zinc-200 px-4 py-3 text-sm text-zinc-500 dark:border-zinc-800">
          Agent 工具调用(读写文件、执行命令)由服务端自动批准并在服务器工作目录内执行,适合云端部署场景。
        </div>
      </section>

      <div>
        <Button variant="outline" onClick={() => location.reload()}>
          刷新页面
        </Button>
      </div>
    </div>
  );
}
