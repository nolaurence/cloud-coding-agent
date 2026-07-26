import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { ModelRef, ReasoningEffort } from "@cca/protocol";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";

const labels: Record<ReasoningEffort, string> = {
  none: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
};

export function ReasoningEffortPicker({
  model,
  disabled = false,
  direction = "up",
  compact = false,
  onChange,
}: {
  model: ModelRef | undefined;
  disabled?: boolean;
  direction?: "up" | "down";
  compact?: boolean;
  onChange: (effort: ReasoningEffort | undefined) => void;
}) {
  const models = useApp((state) => state.models);
  const option = models.find(
    (candidate) =>
      candidate.ref.providerId === model?.providerId && candidate.ref.modelId === model?.modelId,
  );
  const choices = option?.supportedReasoningEfforts ?? [];
  const selected =
    model?.reasoningEffort && choices.includes(model.reasoningEffort)
      ? model.reasoningEffort
      : undefined;
  const defaultLabel = option?.defaultReasoningEffort
    ? `模型默认 (${labels[option.defaultReasoningEffort]})`
    : "模型默认";
  const buttonLabel = selected
    ? `推理强度：${labels[selected]}`
    : `推理强度：${option?.defaultReasoningEffort ? `默认 (${labels[option.defaultReasoningEffort]})` : "默认"}`;
  const compactButtonLabel = selected ? labels[selected] : "默认";
  const available = Boolean(model && option?.supportedReasoningEfforts?.length);
  const items: { value: ReasoningEffort | undefined; label: string }[] = [
    { value: undefined, label: defaultLabel },
    ...choices.map((effort) => ({ value: effort, label: labels[effort] })),
  ];
  const selectedIndex = selected ? choices.indexOf(selected) + 1 : 0;
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const restoreFocusRef = useRef(false);
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<{
    direction: "up" | "down";
    maxHeight?: number;
  }>({ direction });

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  useEffect(() => {
    if (disabled || !available) setOpen(false);
  }, [available, disabled]);

  useEffect(() => {
    if (!disabled && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      triggerRef.current?.focus();
    }
  }, [disabled]);

  useEffect(() => {
    setOpen(false);
  }, [model?.modelId, model?.providerId]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => itemRefs.current[selectedIndex]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, selectedIndex]);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePlacement = () => {
      const root = rootRef.current;
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!root || !trigger || !menu) return;

      let clippingTop = 8;
      let clippingBottom = window.innerHeight - 8;
      for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const overflowY = getComputedStyle(ancestor).overflowY;
        if (!/(auto|scroll|hidden|clip)/.test(overflowY)) continue;
        const rect = ancestor.getBoundingClientRect();
        clippingTop = Math.max(clippingTop, rect.top + 4);
        clippingBottom = Math.min(clippingBottom, rect.bottom - 4);
      }

      const triggerRect = trigger.getBoundingClientRect();
      const available = {
        up: Math.max(0, triggerRect.top - clippingTop - 4),
        down: Math.max(0, clippingBottom - triggerRect.bottom - 4),
      };
      const menuHeight = menu.scrollHeight;
      const resolvedDirection =
        available[direction] >= menuHeight
          ? direction
          : available.up > available.down
            ? "up"
            : "down";
      const maxHeight = Math.min(menuHeight, Math.floor(available[resolvedDirection]));

      setPlacement((current) =>
        current.direction === resolvedDirection && current.maxHeight === maxHeight
          ? current
          : { direction: resolvedDirection, maxHeight },
      );
    };

    updatePlacement();
    window.addEventListener("resize", updatePlacement);
    document.addEventListener("scroll", updatePlacement, true);
    return () => {
      window.removeEventListener("resize", updatePlacement);
      document.removeEventListener("scroll", updatePlacement, true);
    };
  }, [direction, items.length, open]);

  if (!available) return null;

  const close = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const choose = (value: ReasoningEffort | undefined) => {
    setOpen(false);
    restoreFocusRef.current = true;
    triggerRef.current?.focus();
    onChange(value);
    requestAnimationFrame(() => {
      if (!triggerRef.current?.disabled) {
        restoreFocusRef.current = false;
        triggerRef.current?.focus();
      }
    });
  };

  const focusItem = (index: number) => {
    const normalizedIndex = (index + items.length) % items.length;
    itemRefs.current[normalizedIndex]?.focus();
  };

  const focusAdjacentControl = (reverse: boolean) => {
    setOpen(false);
    requestAnimationFrame(() => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const controls = Array.from(
        document.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.getClientRects().length > 0);
      const triggerIndex = controls.indexOf(trigger);
      controls[triggerIndex + (reverse ? -1 : 1)]?.focus();
    });
  };

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={buttonLabel}
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        title={buttonLabel}
        className={cn(
          "flex h-8 items-center justify-between gap-1 rounded-md border border-zinc-300 text-xs transition-colors hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800",
          compact ? "w-16 px-2 sm:w-32 sm:px-2.5" : "w-28 px-2.5 sm:w-32",
        )}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            close();
          }
        }}
      >
        {compact ? (
          <>
            <span className="min-w-0 truncate sm:hidden">{compactButtonLabel}</span>
            <span className="hidden min-w-0 truncate sm:block">{buttonLabel}</span>
          </>
        ) : (
          <span className="min-w-0 truncate">{buttonLabel}</span>
        )}
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 shrink-0 text-zinc-400 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="推理强度选项"
          className={cn(
            "absolute left-0 z-50 w-40 overflow-y-auto overscroll-contain rounded-md border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-900",
            placement.direction === "up" ? "bottom-full mb-1" : "top-full mt-1",
          )}
          style={{ maxHeight: placement.maxHeight }}
          onKeyDown={(event) => {
            const currentIndex = itemRefs.current.findIndex(
              (element) => element === document.activeElement,
            );
            if (event.key === "ArrowDown") {
              event.preventDefault();
              focusItem(currentIndex + 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              focusItem(currentIndex - 1);
            } else if (event.key === "Home") {
              event.preventDefault();
              focusItem(0);
            } else if (event.key === "End") {
              event.preventDefault();
              focusItem(items.length - 1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              close(true);
            } else if (event.key === "Tab") {
              event.preventDefault();
              focusAdjacentControl(event.shiftKey);
            }
          }}
        >
          {items.map((item, index) => {
            const isSelected = item.value === selected;
            return (
              <button
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                key={item.value ?? "default"}
                type="button"
                role="menuitemradio"
                aria-checked={isSelected}
                className={cn(
                  "flex min-h-8 w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none hover:bg-zinc-100 focus-visible:bg-zinc-100 dark:hover:bg-zinc-800 dark:focus-visible:bg-zinc-800",
                  isSelected && "bg-zinc-100 font-medium dark:bg-zinc-800",
                )}
                onClick={() => choose(item.value)}
              >
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {isSelected && <Check className="h-3.5 w-3.5 shrink-0 text-blue-500" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
