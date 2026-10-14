import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  Search,
  Sparkles,
} from "lucide-react";
import { Popover, Slider } from "radix-ui";
import {
  REASONING_EFFORTS,
  normalizeModelRefReasoning,
  type AgentMode,
  type ModelRef,
  type ReasoningEffort,
} from "@cca/protocol";
import { useApp } from "../lib/store";
import "./composer.css";

const effortLabels: Record<ReasoningEffort, string> = {
  none: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

export function ComposerModelPicker({
  value,
  onChange,
  disabled = false,
  updating = false,
  lockedProviderId,
  agentMode = "standard",
  onAgentModeChange,
}: {
  value: ModelRef | undefined;
  onChange: (model: ModelRef) => void;
  disabled?: boolean;
  updating?: boolean;
  lockedProviderId?: string;
  agentMode?: AgentMode;
  onAgentModeChange?: (mode: AgentMode) => boolean | void | Promise<boolean | void>;
}) {
  const models = useApp((state) => state.models);
  const settings = useApp((state) => state.settings);
  const refreshModels = useApp((state) => state.refreshModels);
  const [open, setOpen] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [filter, setFilter] = useState("");
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const modelChoiceRef = useRef<HTMLButtonElement>(null);

  const defaultModel = settings?.defaultModel;
  const current = value ?? (
    lockedProviderId === undefined || defaultModel?.providerId === lockedProviderId
      ? defaultModel
      : undefined
  );
  const option = models.find(
    (model) => model.ref.providerId === current?.providerId && model.ref.modelId === current?.modelId,
  );
  const modelName = (model: ModelRef) =>
    settings?.providers
      .find((provider) => provider.id === model.providerId)?.models
      .find((entry) => entry.id === model.modelId)?.name ?? model.modelId;
  const modelLabel = current ? modelName(current) : "默认模型";
  const efforts = REASONING_EFFORTS.filter((effort) => option?.supportedReasoningEfforts?.includes(effort));
  const selectedEffort = current?.reasoningEffort && efforts.includes(current.reasoningEffort)
    ? current.reasoningEffort
    : undefined;
  const choices: Array<ReasoningEffort | undefined> = [undefined, ...efforts];
  const effortIndex = Math.max(0, choices.indexOf(selectedEffort));
  const displayedIndex = previewIndex ?? effortIndex;
  const displayedEffort = choices[displayedIndex];
  const effortLabel = displayedEffort ? effortLabels[displayedEffort] : "默认";
  const filtered = models.filter((model) =>
    `${model.label} ${model.ref.modelId}`.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const groups = [...new Set(filtered.map((model) => model.ref.providerId))];
  const controlsDisabled = disabled || updating;

  useEffect(() => {
    if (models.length === 0) void refreshModels();
  }, [models.length, refreshModels]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!updating) setPreviewIndex(null);
  }, [effortIndex, current?.providerId, current?.modelId, open, updating]);

  const returnToReasoning = () => {
    setShowModels(false);
    setFilter("");
    requestAnimationFrame(() => modelChoiceRef.current?.focus());
  };

  const select = async (model: ModelRef) => {
    if (agentMode === "ultra" && onAgentModeChange) {
      const changed = await onAgentModeChange("standard");
      if (changed === false) return;
    }
    onChange(normalizeModelRefReasoning(model, models));
  };

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next && !controlsDisabled);
        if (next) {
          setShowModels(false);
          setFilter("");
        }
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className="composer-model-trigger"
          aria-label="选择模型与推理强度"
          disabled={controlsDisabled}
          title={`${option?.label ?? modelLabel} · ${effortLabel}`}
        >
          <span className="composer-model-name">{open ? "选择强度" : modelLabel}</span>
          {!open && <span className="composer-model-effort">{agentMode === "ultra" ? "Ultra" : effortLabel}</span>}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="composer-popover composer-model-panel"
          side="top"
          align="end"
          sideOffset={12}
          collisionPadding={12}
          aria-label="模型与推理强度"
          onEscapeKeyDown={(event) => {
            if (showModels) {
              event.preventDefault();
              returnToReasoning();
            }
          }}
        >
          {showModels ? (
            <div className="composer-panel-view">
              <button type="button" className="composer-model-back" onClick={returnToReasoning}>
                <ArrowLeft className="size-3.5" /> 返回推理设置
              </button>
              <label className="composer-model-search">
                <Search className="size-3.5 shrink-0" aria-hidden="true" />
                <input
                  autoFocus
                  aria-label="搜索模型"
                  placeholder="搜索模型…"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                />
              </label>
              <div className="composer-model-list" role="group" aria-label="模型列表" onKeyDown={(event) => {
                if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
                event.preventDefault();
                const buttons = Array.from(
                  event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
                );
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
                buttons[next]?.focus();
              }}>
                {groups.map((providerId) => (
                  <div key={providerId} role="group" aria-label={settings?.providers.find((provider) => provider.id === providerId)?.name ?? providerId}>
                    <div className="composer-menu-heading">{settings?.providers.find((provider) => provider.id === providerId)?.name ?? providerId}</div>
                    {filtered.filter((model) => model.ref.providerId === providerId).map((model) => {
                      const selected = current?.providerId === providerId && current.modelId === model.ref.modelId;
                      const locked = lockedProviderId !== undefined && providerId !== lockedProviderId;
                      return (
                        <button
                          key={model.ref.modelId}
                          type="button"
                          className="composer-model-option"
                          aria-pressed={selected}
                          disabled={controlsDisabled || locked}
                          title={locked ? "会话创建后不能切换模型提供方" : model.label}
                          onClick={() => {
                            void select({ ...model.ref, reasoningEffort: current?.reasoningEffort });
                            returnToReasoning();
                          }}
                        >
                          <span>{modelName(model.ref)}</span>
                          {selected && <Check className="size-3.5 shrink-0 text-blue-500" aria-hidden="true" />}
                        </button>
                      );
                    })}
                  </div>
                ))}
                {filtered.length === 0 && (
                  <p className="composer-model-empty">
                    {models.length > 0 ? "未找到匹配模型" : "暂无可用模型，请先在设置中配置"}
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="composer-panel-view">
              <div className="composer-reasoning-heading">
                <strong key={effortLabel} aria-live="polite">{agentMode === "ultra" ? "Ultra" : effortLabel}</strong>
                <button
                  type="button"
                  aria-label="重置为默认"
                  title="重置为默认"
                  disabled={controlsDisabled || !current}
                  onClick={() => {
                    const canUseDefault = defaultModel &&
                      (lockedProviderId === undefined || defaultModel.providerId === lockedProviderId) &&
                      models.some((model) =>
                        model.ref.providerId === defaultModel.providerId &&
                        model.ref.modelId === defaultModel.modelId,
                      );
                    if (canUseDefault) void select(defaultModel);
                    else if (current) void select({ providerId: current.providerId, modelId: current.modelId });
                  }}
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                </button>
              </div>
              <button
                ref={modelChoiceRef}
                type="button"
                className="composer-model-choice"
                aria-label="选择模型"
                disabled={controlsDisabled}
                onClick={() => setShowModels(true)}
              >
                <span>{modelLabel}</span>
                <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
              </button>
              {efforts.length > 0 ? (
                <>
                  <Slider.Root
                    className="composer-reasoning-range"
                    min={0}
                    max={efforts.length}
                    step={1}
                    value={[displayedIndex]}
                    disabled={controlsDisabled || !current}
                    onValueChange={([index]) => setPreviewIndex(index ?? 0)}
                    onValueCommit={([index]) => {
                      if (current) void select({ ...current, reasoningEffort: choices[index ?? 0] });
                    }}
                  >
                    <Slider.Track className="composer-reasoning-track">
                      <Slider.Range className="composer-reasoning-fill" />
                      <span className="composer-reasoning-marks" aria-hidden="true">
                        {choices.map((effort) => <span key={effort ?? "default"} />)}
                      </span>
                    </Slider.Track>
                    <Slider.Thumb className="composer-reasoning-thumb" aria-label="推理强度" aria-valuetext={effortLabel} />
                  </Slider.Root>
                  <div className="composer-reasoning-labels" aria-hidden="true">
                    <span>默认</span><span>{effortLabels[efforts[efforts.length - 1]!]}</span>
                  </div>
                </>
              ) : <p className="composer-model-empty">此模型使用默认推理设置</p>}
              {onAgentModeChange && (
                <div className="composer-mode-note">
                  <Sparkles className="size-3.5" aria-hidden="true" />
                  <span>Ultra</span><span>暂不支持</span>
                </div>
              )}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
