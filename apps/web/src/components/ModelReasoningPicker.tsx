import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Search,
  Zap,
} from "lucide-react";
import { REASONING_EFFORTS } from "@cca/protocol";
import type { ModelOption, ModelRef, ReasoningEffort } from "@cca/protocol";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";
import { useEffect, useId, useMemo, useRef, useState } from "react";

const tiers = [
  { label: "轻量", description: "响应更快" },
  { label: "均衡", description: "速度与能力平衡" },
  { label: "高", description: "更强的推理能力" },
  { label: "极高", description: "更深入的思考" },
  { label: "Ultra", description: "最强能力，消耗额度更快" },
] as const;

type PickerView = "menu" | "models" | "effort";

function sameModel(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
  return left?.providerId === right?.providerId && left?.modelId === right?.modelId;
}

function modelEfforts(option: ModelOption | undefined): ReasoningEffort[] {
  return [...(option?.supportedReasoningEfforts ?? [])].sort(
    (left, right) => REASONING_EFFORTS.indexOf(left) - REASONING_EFFORTS.indexOf(right),
  );
}

function tierForEffort(effort: ReasoningEffort | undefined, efforts: ReasoningEffort[]): number {
  if (efforts.length < 2 || !effort) return effort && efforts.length === 1 ? 0 : 1;
  const index = efforts.indexOf(effort);
  if (index < 0) return 1;
  return Math.round((index / (efforts.length - 1)) * (tiers.length - 1));
}

function effortForTier(tier: number, efforts: ReasoningEffort[]): ReasoningEffort | undefined {
  if (efforts.length === 0) return undefined;
  const index = efforts.length === 1
    ? 0
    : Math.round((tier / (tiers.length - 1)) * (efforts.length - 1));
  return efforts[Math.max(0, Math.min(efforts.length - 1, index))];
}

function tierAt(position: number): (typeof tiers)[number] {
  return tiers[Math.max(0, Math.min(tiers.length - 1, Math.round(position)))] ?? tiers[1];
}

export function ModelReasoningPicker({
  value,
  onChange,
  onReasoningChange,
  disabled = false,
  lockedProviderId,
  direction = "up",
}: {
  value: ModelRef | undefined;
  onChange: (value: ModelRef) => void;
  onReasoningChange: (value: ReasoningEffort | undefined) => void;
  disabled?: boolean;
  lockedProviderId?: string;
  direction?: "up" | "down";
}) {
  const models = useApp((state) => state.models);
  const settings = useApp((state) => state.settings);
  const refreshModels = useApp((state) => state.refreshModels);
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<PickerView>("menu");
  const [filter, setFilter] = useState("");
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (models.length === 0) void refreshModels();
  }, [models.length, refreshModels]);

  useEffect(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, []);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) {
      setView("menu");
      setFilter("");
      setDragPosition(null);
      setDragging(false);
    }
  }, [open]);

  const defaultModel =
    lockedProviderId === undefined || settings?.defaultModel?.providerId === lockedProviderId
      ? settings?.defaultModel
      : undefined;
  const current = value ?? defaultModel;
  const option = models.find((candidate) => sameModel(candidate.ref, current));
  const currentLabel = option?.label ?? (current ? `${current.providerId} / ${current.modelId}` : "默认模型");
  const efforts = useMemo(() => modelEfforts(option), [option]);
  const selectedEffort = current?.reasoningEffort && efforts.includes(current.reasoningEffort)
    ? current.reasoningEffort
    : undefined;
  const defaultEffort = selectedEffort ?? option?.defaultReasoningEffort;
  const selectedTier = tierForEffort(defaultEffort, efforts);
  const position = dragPosition ?? selectedTier;
  const effortLabel = efforts.length > 0 ? tierAt(selectedTier).label : "默认";
  const filteredModels = models.filter((candidate) =>
    candidate.label.toLowerCase().includes(filter.toLowerCase()),
  );

  const updateFromClientX = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    setDragPosition(Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * (tiers.length - 1));
  };

  const commitTier = (tier: number) => {
    const normalized = Math.max(0, Math.min(tiers.length - 1, Math.round(tier)));
    setDragPosition(null);
    onReasoningChange(effortForTier(normalized, efforts));
  };

  const onSliderPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (efforts.length === 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    updateFromClientX(event.clientX);
  };

  const onSliderPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    updateFromClientX(event.clientX);
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const rect = trackRef.current?.getBoundingClientRect();
    const raw = rect && rect.width > 0
      ? ((event.clientX - rect.left) / rect.width) * (tiers.length - 1)
      : selectedTier;
    commitTier(raw);
  };

  const onSliderPointerCancel = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    setDragPosition(null);
  };

  const onSliderKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (efforts.length === 0) return;
    let next: number | undefined;
    if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = selectedTier - 1;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = selectedTier + 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tiers.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    commitTier(next);
  };

  return (
    <div className="relative min-w-0 shrink-0" ref={rootRef}>
      <button
        type="button"
        aria-label="选择模型和推理强度"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        title={`${currentLabel} · ${effortLabel}`}
        className={cn(
          "flex h-9 max-w-[min(15.625rem,calc(100vw-1rem))] items-center rounded-full bg-zinc-100 px-3.5 pr-9 text-xs transition-[background-color,transform] hover:bg-zinc-200 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-800 dark:hover:bg-zinc-700",
          selectedTier === tiers.length - 1 && efforts.length > 0 && "text-violet-700 dark:text-violet-300",
        )}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        <Zap className="mr-1.5 h-3.5 w-3.5 shrink-0" />
        <span className="truncate font-semibold text-zinc-900 dark:text-zinc-100">{currentLabel}</span>
        <span className="ml-1.5 shrink-0 font-normal text-zinc-500 dark:text-zinc-400">{effortLabel}</span>
        <ChevronDown className={cn("absolute right-3 h-3.5 w-3.5 text-zinc-400 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div
          id={menuId}
          role="dialog"
          aria-label="模型设置"
          className={cn(
            "absolute right-0 z-50 w-[min(19rem,calc(100vw-1rem))] overflow-hidden rounded-2xl border border-zinc-200 bg-white p-2 shadow-[0_0_0_0.5px_rgba(26,29,33,.05),0_2px_6px_rgba(26,29,33,.06),0_12px_32px_rgba(26,29,33,.13)] dark:border-zinc-700 dark:bg-zinc-900",
            direction === "up" ? "bottom-full mb-2" : "top-full mt-2",
          )}
        >
          {view === "menu" && (
            <div className="space-y-1">
              <button
                type="button"
                className="flex h-9 w-full items-center gap-2 rounded-xl px-3 text-left hover:bg-zinc-100 dark:hover:bg-zinc-800"
                onClick={() => setView("models")}
              >
                <span className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">模型</span>
                <span className="max-w-36 truncate text-sm text-zinc-500 dark:text-zinc-400">{currentLabel}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              </button>
              <button
                type="button"
                disabled={efforts.length === 0}
                className="flex h-9 w-full items-center gap-2 rounded-xl px-3 text-left hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-zinc-800"
                onClick={() => setView("effort")}
              >
                <span className="flex-1 text-sm font-semibold text-zinc-900 dark:text-zinc-100">推理强度</span>
                <span className="text-sm text-zinc-500 dark:text-zinc-400">{effortLabel}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
              </button>
              <div className="my-1 h-px bg-zinc-100 dark:bg-zinc-800" />
              <div className="px-3 py-1 text-[11px] leading-4 text-zinc-400">
                左侧响应更快，右侧推理更强
              </div>
            </div>
          )}

          {view === "models" && (
            <div>
              <div className="mb-1 flex items-center gap-1">
                <button
                  type="button"
                  aria-label="返回模型设置"
                  className="rounded-lg p-1.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  onClick={() => setView("menu")}
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">选择模型</span>
              </div>
              <label className="relative block px-1 pb-1" aria-label="搜索模型">
                <Search className="pointer-events-none absolute left-3 top-2 h-3.5 w-3.5 text-zinc-400" />
                <input
                  autoFocus
                  className="h-8 w-full rounded-lg border border-zinc-200 bg-transparent pl-8 pr-2 text-xs outline-none focus:border-zinc-400 dark:border-zinc-700"
                  placeholder="搜索模型"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") setView("menu");
                  }}
                />
              </label>
              <div className="max-h-56 overflow-y-auto p-1">
                {filteredModels.length === 0 && (
                  <div className="px-2 py-4 text-center text-xs text-zinc-500">无可用模型</div>
                )}
                {filteredModels.map((candidate) => {
                  const selected = sameModel(current, candidate.ref);
                  const providerLocked = lockedProviderId !== undefined && candidate.ref.providerId !== lockedProviderId;
                  return (
                    <button
                      key={`${candidate.ref.providerId}:${candidate.ref.modelId}`}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      aria-disabled={providerLocked}
                      disabled={providerLocked}
                      title={providerLocked ? "会话创建后不能切换模型提供方" : candidate.label}
                      className={cn(
                        "flex min-h-9 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-zinc-800",
                        selected && "bg-zinc-100 font-medium dark:bg-zinc-800",
                      )}
                      onClick={() => {
                        onChange(candidate.ref);
                        setView("menu");
                        setOpen(false);
                      }}
                    >
                      <span className="min-w-0 flex-1 truncate">{candidate.label}</span>
                      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-blue-500" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {view === "effort" && (
            <div className="px-2 pb-2 pt-1">
              <div className="mb-3 flex items-center justify-between">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
                  onClick={() => setView("menu")}
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  推理强度
                </button>
                <button
                  type="button"
                  aria-label="恢复模型默认推理强度"
                  title="恢复模型默认推理强度"
                  className="rounded-full p-1.5 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                  onClick={() => onReasoningChange(undefined)}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="mb-3 text-center">
                <div className={cn("text-lg font-semibold", tierAt(position) === tiers[tiers.length - 1] ? "text-violet-600 dark:text-violet-400" : "text-blue-600 dark:text-blue-400")}>
                  {tierAt(position).label}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {tierAt(position).description}
                </div>
              </div>
              <div
                ref={trackRef}
                role="slider"
                tabIndex={0}
                aria-label="模型智能程度"
                aria-valuemin={0}
                aria-valuemax={tiers.length - 1}
                aria-valuenow={Math.round(position)}
                aria-valuetext={tierAt(position).label}
                className={cn("relative h-10 touch-none cursor-grab outline-none", dragging && "cursor-grabbing")}
                onPointerDown={onSliderPointerDown}
                onPointerMove={(event) => {
                  if (dragging) updateFromClientX(event.clientX);
                }}
                onPointerUp={onSliderPointerUp}
                onPointerCancel={onSliderPointerCancel}
                onKeyDown={onSliderKeyDown}
              >
                <div className="absolute inset-x-0 top-1/2 h-7 -translate-y-1/2 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-blue-600 via-indigo-500 to-violet-400 transition-[width] duration-150"
                    style={{ width: `${(position / (tiers.length - 1)) * 100}%` }}
                  />
                  {tiers.map((tier, index) => (
                    <span
                      key={tier.label}
                      className="absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-zinc-400/80"
                      style={{ left: `${(index / (tiers.length - 1)) * 100}%` }}
                    />
                  ))}
                </div>
                <span
                  className={cn(
                    "pointer-events-none absolute top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_0.5px_rgba(26,29,33,.03),0_1px_2px_rgba(26,29,33,.1),0_2px_6px_rgba(26,29,33,.14)] transition-[left,transform] duration-200 dark:bg-zinc-50",
                    dragging && "scale-105",
                  )}
                  style={{ left: `${(position / (tiers.length - 1)) * 100}%` }}
                />
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-zinc-400">
                <span>更快</span>
                <span>更聪明</span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
