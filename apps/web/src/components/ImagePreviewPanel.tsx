import { useEffect, useRef, useState } from "react";
import { ImageOff, Loader2, Maximize2, Scan, ZoomIn, ZoomOut } from "lucide-react";
import type { ImagePreviewTarget } from "../lib/imagePreview";
import { useImageObjectUrl } from "../hooks/useImageObjectUrl";
import { Button } from "@/components/ui/button";

const VIEW_PADDING = 48;
const MIN_SCALE = 0.01;
const MAX_SCALE = 8;

type Size = { width: number; height: number };

function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function ImagePreviewPanel({ image }: { image: ImagePreviewTarget }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const { src, loading, error } = useImageObjectUrl(image);
  const [naturalSize, setNaturalSize] = useState<Size | null>(null);
  const [viewportSize, setViewportSize] = useState<Size>({ width: 0, height: 0 });
  const [scale, setScale] = useState(1);
  const [fitToViewport, setFitToViewport] = useState(true);

  useEffect(() => {
    setNaturalSize(null);
    setScale(1);
    setFitToViewport(true);
  }, [image.id, image.threadId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const measure = () => {
      const rect = viewport.getBoundingClientRect();
      setViewportSize({ width: rect.width, height: rect.height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const fitScale = naturalSize && viewportSize.width > 0 && viewportSize.height > 0
    ? Math.min(
        1,
        Math.max(MIN_SCALE, (viewportSize.width - VIEW_PADDING) / naturalSize.width),
        Math.max(MIN_SCALE, (viewportSize.height - VIEW_PADDING) / naturalSize.height),
      )
    : 1;

  useEffect(() => {
    if (fitToViewport && naturalSize) setScale(fitScale);
  }, [fitScale, fitToViewport, naturalSize]);

  const zoomBy = (factor: number) => {
    setFitToViewport(false);
    setScale((current) => clampScale(current * factor));
  };
  const showOriginalSize = () => {
    setFitToViewport(false);
    setScale(1);
  };
  const fitImage = () => {
    setFitToViewport(true);
    setScale(fitScale);
  };

  const scaledWidth = naturalSize ? naturalSize.width * scale : 0;
  const scaledHeight = naturalSize ? naturalSize.height * scale : 0;
  const originalSizeActive = !fitToViewport && Math.abs(scale - 1) < 0.001;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
        <div className="min-w-28 flex-1 truncate px-1.5 text-xs text-muted-foreground" title={image.displayName}>
          {image.displayName}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!naturalSize || scale <= MIN_SCALE}
            aria-label="缩小图片"
            title="缩小"
            onClick={() => zoomBy(0.8)}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <span className="w-12 text-center text-[11px] tabular-nums text-muted-foreground">
            {Math.round(scale * 100)}%
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={!naturalSize || scale >= MAX_SCALE}
            aria-label="放大图片"
            title="放大"
            onClick={() => zoomBy(1.25)}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant={fitToViewport ? "secondary" : "ghost"}
            size="icon-sm"
            disabled={!naturalSize}
            aria-label="使图片适应窗口"
            aria-pressed={fitToViewport}
            title="适应窗口"
            onClick={fitImage}
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant={originalSizeActive ? "secondary" : "ghost"}
            size="icon-sm"
            disabled={!naturalSize}
            aria-label="按原始大小显示图片"
            aria-pressed={originalSizeActive}
            title="原始大小"
            onClick={showOriginalSize}
          >
            <Scan className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div
        ref={viewportRef}
        className="min-h-0 flex-1 overflow-auto bg-zinc-100/70 dark:bg-zinc-900/70"
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return;
          event.preventDefault();
          zoomBy(event.deltaY < 0 ? 1.25 : 0.8);
        }}
      >
        {loading ? (
          <div className="flex h-full min-h-48 items-center justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
            <ImageOff className="h-6 w-6" />
            <span>{error}</span>
          </div>
        ) : src ? (
          <div
            className="grid min-h-full min-w-full place-items-center p-6"
            style={naturalSize ? {
              width: Math.max(viewportSize.width, scaledWidth + VIEW_PADDING),
              height: Math.max(viewportSize.height, scaledHeight + VIEW_PADDING),
            } : undefined}
          >
            <img
              src={src}
              alt={image.displayName}
              draggable={false}
              decoding="async"
              className="max-w-none select-none object-contain shadow-sm"
              style={naturalSize ? { width: scaledWidth, height: scaledHeight } : { maxWidth: "100%", maxHeight: "100%" }}
              onLoad={(event) => setNaturalSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
