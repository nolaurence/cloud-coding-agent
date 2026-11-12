import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  RotateCcw,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import {
  COMPOSER_MODEL_MOTION,
  modelSectionHeading,
  pickerTriggerCopy,
  playRectMorph,
  prefersReducedMotion,
  type MorphRect,
} from "./composerModelPicker";
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

function readRect(node: HTMLElement | null): MorphRect | null {
  if (!node) return null;
  const rect = node.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

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
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const morphRef = useRef<HTMLDivElement>(null);
  const modelChoiceRef = useRef<HTMLButtonElement>(null);
  const pendingFromRef = useRef<MorphRect | null>(null);
  const morphKindRef = useRef<"open" | "view" | null>(null);
  const closingRef = useRef(false);
  const closeGenerationRef = useRef(0);
  const activeAnimationRef = useRef<Animation | null>(null);

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
  const groups = [...new Set(models.map((model) => model.ref.providerId))];
  const controlsDisabled = disabled || updating;
  const triggerCopy = pickerTriggerCopy({
    open,
    showModels,
    modelLabel,
    effortLabel: agentMode === "ultra" ? "Ultra" : effortLabel,
  });

  const cancelMorph = () => {
    activeAnimationRef.current?.cancel();
    activeAnimationRef.current = null;
  };

  const playMorphFrom = (from: MorphRect, duration: number, easing: string, opacityFrom = 1) => {
    const element = morphRef.current;
    const to = readRect(element);
    if (!element || !to) return null;
    cancelMorph();
    if (prefersReducedMotion()) return null;
    const animation = playRectMorph(element, from, to, { duration, easing, opacityFrom, opacityTo: 1 });
    activeAnimationRef.current = animation;
    return animation;
  };

  const closeWithMorph = async () => {
    if (!open || closingRef.current) return;
    closingRef.current = true;
    const generation = closeGenerationRef.current + 1;
    closeGenerationRef.current = generation;
    const element = morphRef.current;
    const trigger = readRect(triggerRef.current);
    const layout = readRect(element);
    if (element && trigger && layout && !prefersReducedMotion()) {
      cancelMorph();
      const animation = playRectMorph(element, layout, trigger, {
        duration: COMPOSER_MODEL_MOTION.closeMs,
        easing: COMPOSER_MODEL_MOTION.closeEasing,
        opacityFrom: 1,
        opacityTo: 0.92,
        persist: true,
      });
      activeAnimationRef.current = animation;
      try {
        await animation?.finished;
      } catch {
        // cancelled by a newer animation
      }
    }
    if (closeGenerationRef.current !== generation) return;
    setOpen(false);
    setShowModels(false);
    closingRef.current = false;
  };

  const returnToReasoning = () => {
    pendingFromRef.current = readRect(morphRef.current);
    morphKindRef.current = "view";
    setShowModels(false);
    requestAnimationFrame(() => modelChoiceRef.current?.focus());
  };

  const openModels = () => {
    pendingFromRef.current = readRect(morphRef.current);
    morphKindRef.current = "view";
    setShowModels(true);
  };

  useEffect(() => {
    if (!open || !showModels) return;
    const selected =
      morphRef.current?.querySelector<HTMLButtonElement>(".composer-model-option.is-selected:not(:disabled)") ??
      morphRef.current?.querySelector<HTMLButtonElement>(".composer-model-option:not(:disabled)");
    selected?.focus();
  }, [open, showModels]);

  useEffect(() => {
    if (models.length === 0) void refreshModels();
  }, [models.length, refreshModels]);

  useEffect(() => {
    if (disabled) {
      cancelMorph();
      setOpen(false);
      setShowModels(false);
    }
  }, [disabled]);

  useEffect(() => {
    if (!updating) setPreviewIndex(null);
  }, [effortIndex, current?.providerId, current?.modelId, open, updating]);

  useLayoutEffect(() => {
    if (!open) return;
    const from = pendingFromRef.current;
    const kind = morphKindRef.current;
    pendingFromRef.current = null;
    morphKindRef.current = null;
    if (!from) return;
    if (kind === "open") {
      playMorphFrom(from, COMPOSER_MODEL_MOTION.openMs, COMPOSER_MODEL_MOTION.openEasing, 0.88);
      return;
    }
    if (kind === "view") {
      playMorphFrom(from, COMPOSER_MODEL_MOTION.viewMs, COMPOSER_MODEL_MOTION.viewEasing);
    }
  }, [open, showModels]);

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
        if (controlsDisabled) return;
        if (next) {
          pendingFromRef.current = readRect(triggerRef.current);
          morphKindRef.current = "open";
          closingRef.current = false;
          closeGenerationRef.current += 1;
          setShowModels(false);
          setOpen(true);
          return;
        }
        void closeWithMorph();
      }}
    >
      <Tooltip delayDuration={200} open={open || controlsDisabled ? false : undefined}>
        <TooltipTrigger asChild>
          <Popover.Trigger asChild>
            <button
              ref={triggerRef}
              type="button"
              className={`composer-model-trigger${triggerCopy.muted ? " is-prompt" : ""}`}
              aria-label="选择模型与推理强度"
              disabled={controlsDisabled}
            >
              <span className="composer-model-name">{triggerCopy.name}</span>
              {triggerCopy.effort && (
                <span className="composer-model-effort">{triggerCopy.effort}</span>
              )}
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            </button>
          </Popover.Trigger>
        </TooltipTrigger>
        <TooltipContent
          side="top"
          align="center"
          sideOffset={8}
          showArrow={false}
          className="composer-model-tooltip rounded-lg px-3 py-1.5 text-[12px] leading-4 shadow-lg"
        >
          选择推理强度
        </TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          className={`composer-popover composer-model-panel${showModels ? " is-models" : ""}`}
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label="模型与推理强度"
          onEscapeKeyDown={(event) => {
            if (showModels) {
              event.preventDefault();
              returnToReasoning();
            }
          }}
        >
          <div ref={morphRef} className={`composer-model-morph${showModels ? " is-models" : ""}`}>
            <div
              className={`composer-panel-view composer-reasoning-view${showModels ? " is-hidden" : " is-active"}`}
              aria-hidden={showModels}
              {...(showModels ? { inert: true } : {})}
            >
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
                onClick={openModels}
              >
                <span>{modelLabel}</span>
                <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
              </button>
              {efforts.length > 0 ? (
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
              ) : <p className="composer-model-empty">此模型使用默认推理设置</p>}
            </div>

            <div
              className={`composer-panel-view composer-models-view${showModels ? " is-active" : " is-hidden"}`}
              aria-hidden={!showModels}
              {...(!showModels ? { inert: true } : {})}
            >
              <div className="composer-model-list-header">选择模型</div>
              <div
                className="composer-model-list"
                role="group"
                aria-label="模型列表"
                onKeyDown={(event) => {
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
                }}
              >
                {groups.map((providerId, groupIndex) => {
                  const providerName = settings?.providers.find((provider) => provider.id === providerId)?.name ?? providerId;
                  const isDefaultGroup = defaultModel
                    ? providerId === defaultModel.providerId
                    : groupIndex === 0;
                  const heading = modelSectionHeading(providerName, isDefaultGroup);
                  const groupModels = models.filter((model) => model.ref.providerId === providerId);
                  return (
                    <div key={providerId} role="group" aria-label={providerName}>
                      <div className="composer-model-section">
                        <div className="composer-model-section-title">{heading.title}</div>
                        {heading.subtitle && (
                          <div className="composer-model-section-sub">{heading.subtitle}</div>
                        )}
                      </div>
                      {groupModels.map((model) => {
                        const selected = current?.providerId === providerId && current.modelId === model.ref.modelId;
                        const locked = lockedProviderId !== undefined && providerId !== lockedProviderId;
                        return (
                          <button
                            key={`${providerId}:${model.ref.modelId}`}
                            type="button"
                            className={`composer-model-option${selected ? " is-selected" : ""}`}
                            aria-pressed={selected}
                            disabled={controlsDisabled || locked}
                            title={locked ? "会话创建后不能切换模型提供方" : undefined}
                            onClick={() => {
                              void select({ ...model.ref, reasoningEffort: current?.reasoningEffort });
                              returnToReasoning();
                            }}
                          >
                            <span>{modelName(model.ref)}</span>
                            {selected && <Check className="size-3.5 shrink-0" strokeWidth={2.25} aria-hidden="true" />}
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
                {models.length === 0 && (
                  <p className="composer-model-empty">暂无可用模型，请先在设置中配置</p>
                )}
              </div>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
