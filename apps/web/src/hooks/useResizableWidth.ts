import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export interface ResizableWidthHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly onDoubleClick: () => void;
}

export function useResizableWidth({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  edge,
}: {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  edge: "left" | "right";
}): {
  width: number;
  resizing: boolean;
  handlers: ResizableWidthHandlers;
} {
  const clamp = useCallback(
    (value: number) => Math.max(minWidth, Math.min(maxWidth, value)),
    [maxWidth, minWidth],
  );
  const [width, setWidth] = useState(() => {
    if (typeof window === "undefined") return defaultWidth;
    try {
      const stored = window.localStorage.getItem(storageKey);
      if (stored === null) return defaultWidth;
      const parsed = Number(stored);
      return Number.isFinite(parsed) ? parsed : defaultWidth;
    } catch {
      return defaultWidth;
    }
  });
  const [resizing, setResizing] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    pendingWidth: number;
    animationFrame: number | null;
    target: HTMLElement;
  } | null>(null);

  const persist = useCallback(
    (value: number) => {
      try {
        window.localStorage.setItem(storageKey, String(value));
      } catch {
        // Width persistence is optional when storage is unavailable.
      }
    },
    [storageKey],
  );

  const releasePointer = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.animationFrame !== null) window.cancelAnimationFrame(drag.animationFrame);
    try {
      if (drag.target.hasPointerCapture(drag.pointerId)) {
        drag.target.releasePointerCapture(drag.pointerId);
      }
    } catch {
      // Pointer capture may already have been released by the browser.
    }
    dragRef.current = null;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    setResizing(false);
  }, []);

  useEffect(() => releasePointer, [releasePointer]);

  const commitWidth = useCallback(
    (value: number) => {
      const nextWidth = clamp(value);
      setWidth(nextWidth);
      persist(nextWidth);
    },
    [clamp, persist],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
      const currentWidth = clamp(width);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: currentWidth,
        pendingWidth: currentWidth,
        animationFrame: null,
        target,
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      setResizing(true);
    },
    [clamp, width],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      event.preventDefault();
      const delta = edge === "left" ? drag.startX - event.clientX : event.clientX - drag.startX;
      drag.pendingWidth = clamp(drag.startWidth + delta);
      if (drag.animationFrame !== null) return;
      drag.animationFrame = window.requestAnimationFrame(() => {
        const activeDrag = dragRef.current;
        if (!activeDrag) return;
        activeDrag.animationFrame = null;
        setWidth(activeDrag.pendingWidth);
      });
    },
    [clamp, edge],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const finalWidth = clamp(drag.pendingWidth);
      releasePointer();
      commitWidth(finalWidth);
    },
    [clamp, commitWidth, releasePointer],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const startWidth = drag.startWidth;
      releasePointer();
      setWidth(startWidth);
    },
    [releasePointer],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const step = event.shiftKey ? 64 : 16;
      let nextWidth: number | null = null;
      if (event.key === "Home") nextWidth = minWidth;
      if (event.key === "End") nextWidth = maxWidth;
      if (event.key === "ArrowLeft") nextWidth = width + (edge === "left" ? step : -step);
      if (event.key === "ArrowRight") nextWidth = width + (edge === "left" ? -step : step);
      if (nextWidth === null) return;
      event.preventDefault();
      commitWidth(nextWidth);
    },
    [commitWidth, edge, maxWidth, minWidth, width],
  );

  return {
    width: clamp(width),
    resizing,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel,
      onKeyDown,
      onDoubleClick: () => commitWidth(defaultWidth),
    },
  };
}
