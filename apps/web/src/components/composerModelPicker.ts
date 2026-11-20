export const COMPOSER_MODEL_MOTION = {
  openMs: 300,
  closeMs: 240,
  viewMs: 280,
  openEasing: "cubic-bezier(0.22, 1, 0.36, 1)",
  closeEasing: "cubic-bezier(0.32, 0.72, 0, 1)",
  viewEasing: "cubic-bezier(0.22, 1, 0.36, 1)",
} as const;

/** Visual size of `.composer-reasoning-thumb`; keep in sync with composer.css. */
export const REASONING_THUMB_SIZE_PX = 28;

/**
 * Width of the blue fill so it runs from the track's left edge to the thumb
 * center. Radix's Slider.Range uses the raw value percentage of the full
 * track, but the thumb is inset by `getThumbInBoundsOffset` (half the thumb
 * at 0%, none at 50%, minus half at 100%). Using that padded span keeps the
 * fill flush with the thumb at every stop, including during width/left
 * transitions and the model-picker morph (both layout in the same box).
 */
export function reasoningFillWidthPx(
  progress: number,
  trackWidth: number,
  thumbSize = REASONING_THUMB_SIZE_PX,
): number {
  if (!(trackWidth > 0) || !(thumbSize >= 0)) return 0;
  const t = Math.min(Math.max(progress, 0), 1);
  const usable = Math.max(trackWidth - thumbSize, 0);
  return thumbSize / 2 + t * usable;
}

export function reasoningSliderProgress(index: number, max: number): number {
  if (!(max > 0)) return 0;
  return Math.min(Math.max(index, 0), max) / max;
}

export type MorphRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export function prefersReducedMotion(
  query: ((query: string) => { matches: boolean }) | undefined = globalThis.matchMedia?.bind(globalThis),
): boolean {
  try {
    return Boolean(query?.("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    return false;
  }
}

export function rectToTransform(layout: MorphRect, visual: MorphRect): string {
  const tx = visual.left - layout.left;
  const ty = visual.top - layout.top;
  const sx = layout.width === 0 ? 1 : visual.width / layout.width;
  const sy = layout.height === 0 ? 1 : visual.height / layout.height;
  return `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`;
}

export function playRectMorph(
  element: HTMLElement,
  from: MorphRect,
  to: MorphRect,
  options: {
    duration: number;
    easing: string;
    opacityFrom?: number;
    opacityTo?: number;
    persist?: boolean;
  },
): Animation | null {
  if (typeof element.animate !== "function") return null;
  const bounds = element.getBoundingClientRect();
  const layout: MorphRect = {
    left: bounds.left,
    top: bounds.top,
    width: bounds.width,
    height: bounds.height,
  };
  element.style.transformOrigin = "0 0";
  const animation = element.animate(
    [
      {
        transform: rectToTransform(layout, from),
        opacity: options.opacityFrom ?? 1,
      },
      {
        transform: rectToTransform(layout, to),
        opacity: options.opacityTo ?? 1,
      },
    ],
    {
      duration: options.duration,
      easing: options.easing,
      fill: "both",
    },
  );
  if (!options.persist) {
    void animation.finished.then(
      () => {
        if (animation.playState === "finished") {
          element.style.transform = "";
          element.style.opacity = "";
          animation.cancel();
        }
      },
      () => undefined,
    );
  }
  return animation;
}

export function pickerTriggerCopy(args: {
  open: boolean;
  showModels: boolean;
  modelLabel: string;
  effortLabel: string;
}): { name: string; effort: string | null; muted: boolean } {
  if (args.open && !args.showModels) {
    return { name: "选择推理强度", effort: null, muted: true };
  }
  return { name: args.modelLabel, effort: args.effortLabel, muted: false };
}

export function modelSectionHeading(
  providerName: string,
  isDefaultGroup: boolean,
): { title: string; subtitle: string | null } {
  if (isDefaultGroup) return { title: "默认", subtitle: "推荐模型集" };
  return { title: providerName, subtitle: null };
}
