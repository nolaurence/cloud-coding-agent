import { useState } from "react";
import { useApp } from "../../lib/store";
import { THEME_OPTIONS, useTheme, type ThemePreference } from "../../lib/theme";
import { ModelPicker } from "../../components/ModelPicker";
import { ReasoningEffortPicker } from "../../components/ReasoningEffortPicker";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GitBindingsSettings } from "./GitBindingsSettings";

export function GeneralSettings() {
  const user = useApp((s) => s.user);
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [updatingImageGeneration, setUpdatingImageGeneration] = useState(false);
  const [imageGenerationError, setImageGenerationError] = useState("");

  if (!settings) return null;

  const setImageGenerationEnabled = async (imageGenerationEnabled: boolean) => {
    if (updatingImageGeneration) return;
    setUpdatingImageGeneration(true);
    setImageGenerationError("");
    try {
      await updateSettings({ ...settings, imageGenerationEnabled });
    } catch (error) {
      setImageGenerationError(error instanceof Error ? error.message : "修改生图设置失败");
    } finally {
      setUpdatingImageGeneration(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h2 className="mb-3 text-base font-semibold">外观</h2>
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <div>
            <div className="text-sm">界面主题</div>
            <div className="text-xs text-zinc-500">
              当前显示：{resolvedTheme === "dark" ? "深色" : "浅色"}
            </div>
          </div>
          <div className="w-36">
            <Select
              value={theme}
              onValueChange={(value) => setTheme(value as ThemePreference)}
            >
              <SelectTrigger className="w-full" aria-label="界面主题">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEME_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      <GitBindingsSettings />

      {user?.role === "admin" && (
        <section>
          <h2 className="mb-3 text-base font-semibold">默认模型</h2>
          <div className="flex flex-col gap-3 rounded-lg border border-zinc-200 px-4 py-3 xl:flex-row xl:items-center xl:justify-between dark:border-zinc-800">
            <div>
              <div className="text-sm">新会话默认使用的模型</div>
              <div className="text-xs text-zinc-500">
                可在「模型」页添加 OpenAI / OpenAI Responses 协议的服务
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ModelPicker
                value={settings.defaultModel}
                direction="down"
                onChange={(ref) => void updateSettings({ ...settings, defaultModel: ref })}
              />
              <ReasoningEffortPicker
                model={settings.defaultModel}
                direction="down"
                onChange={(reasoningEffort) => {
                  if (settings.defaultModel) {
                    void updateSettings({
                      ...settings,
                      defaultModel: { ...settings.defaultModel, reasoningEffort },
                    });
                  }
                }}
              />
            </div>
          </div>
        </section>
      )}

      {user?.role === "admin" && (
        <section>
          <h2 className="mb-3 text-base font-semibold">图片生成</h2>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div>
              <label htmlFor="image-generation-enabled" className="text-sm">启用生图功能</label>
              <div id="image-generation-description" className="text-xs text-zinc-500">
                使用「模型」页配置的 GPT Image 模型生成图片，对所有会话生效。修改前请先停止正在运行的任务。
              </div>
            </div>
            <Switch
              id="image-generation-enabled"
              aria-describedby="image-generation-description"
              checked={settings.imageGenerationEnabled !== false}
              disabled={updatingImageGeneration}
              onCheckedChange={(checked) => void setImageGenerationEnabled(checked)}
            />
          </div>
          {imageGenerationError && (
            <p role="alert" className="mt-2 text-sm text-red-500">{imageGenerationError}</p>
          )}
        </section>
      )}

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
