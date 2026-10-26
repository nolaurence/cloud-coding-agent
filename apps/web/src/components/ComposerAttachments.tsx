import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileText, Loader2, RotateCcw, X } from "lucide-react";
import { fileSizeText, type ComposerAttachment } from "../lib/composerAttachments";
import { cn } from "../lib/utils";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";

export function ComposerAttachments({ attachments, disabled, onRemove, onRetry }: {
  attachments: readonly ComposerAttachment[];
  disabled: boolean;
  onRemove: (id: string) => void;
  onRetry: (id: string) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const countRef = useRef(attachments.length);
  const [edges, setEdges] = useState({ left: false, right: false });
  const [previewId, setPreviewId] = useState<string | null>(null);
  const preview = attachments.find((item) => item.id === previewId);
  const updateEdges = useCallback(() => {
    const rail = railRef.current;
    if (!rail) return;
    const left = rail.scrollLeft > 1;
    const right = rail.scrollLeft < rail.scrollWidth - rail.clientWidth - 1;
    setEdges((current) => current.left === left && current.right === right ? current : { left, right });
  }, []);

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (rail && attachments.length > countRef.current) rail.scrollLeft = rail.scrollWidth;
    countRef.current = attachments.length;
    updateEdges();
  }, [attachments.length, updateEdges]);

  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(rail);
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY === 0 || rail.scrollWidth <= rail.clientWidth) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rail.clientWidth : 1;
      rail.scrollBy({ left: (event.deltaX || Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY), 60)) * scale });
    };
    rail.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      observer.disconnect();
      rail.removeEventListener("wheel", onWheel);
    };
  }, [updateEdges]);

  const page = (direction: number) => {
    const rail = railRef.current;
    rail?.scrollBy({
      left: direction * Math.max(rail.clientWidth - 64, 200),
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };

  return (
    <div className="composer-attachments">
      {edges.left && (
        <button type="button" className="composer-rail-arrow is-left" aria-label="向左查看附件" onClick={() => page(-1)}>
          <ChevronLeft className="size-4" />
        </button>
      )}
      <div ref={railRef} className="composer-attachment-rail" role="group" aria-label="待发送附件" onScroll={updateEdges}>
        {attachments.map((item) => {
          const failed = item.status === "error";
          const uploading = item.status === "uploading";
          return (
            <div
              key={item.id}
              className={cn("composer-attachment", item.kind === "image" ? "is-image" : "is-file", failed && "is-error")}
              title={item.error ?? item.file.name}
              aria-busy={uploading}
            >
              {item.kind === "image" ? (
                <>
                  <button
                    type="button"
                    className="composer-image-preview"
                    aria-label={`预览图片 ${item.file.name}`}
                    onClick={() => setPreviewId(item.id)}
                  >
                    <img src={item.previewUrl} alt={item.file.name} />
                  </button>
                  {uploading && <span className="composer-image-status" role="status" aria-label={`${item.file.name} 上传中`}><Loader2 className="size-5 animate-spin" /></span>}
                  {failed && (
                    <button type="button" className="composer-image-status is-error" aria-label={`重试上传 ${item.file.name}`} disabled={disabled} onClick={() => onRetry(item.id)}>
                      <RotateCcw className="size-5" />
                      <span>重试</span>
                    </button>
                  )}
                </>
              ) : (
                <>
                  <span className="composer-file-icon" aria-hidden="true">
                    {uploading ? <Loader2 className="size-5 animate-spin" /> : <FileText className="size-7" strokeWidth={1.5} />}
                  </span>
                  <button
                    type="button"
                    className="composer-file-body"
                    disabled={!failed || disabled}
                    aria-label={failed ? `重试上传 ${item.file.name}` : `${item.file.name}，${uploading ? "上传中" : fileSizeText(item.file.size)}`}
                    onClick={() => onRetry(item.id)}
                  >
                    <span className="composer-file-name">{item.file.name}</span>
                    <span className="composer-file-meta" role={uploading || failed ? "status" : undefined}>
                      {uploading ? "正在上传…" : failed ? "上传失败 · 点击重试" : `${item.file.name.split(".").pop()?.toUpperCase().slice(0, 8) ?? "文件"} · ${fileSizeText(item.file.size)}`}
                    </span>
                  </button>
                  {uploading && <span className="composer-file-progress" aria-hidden="true"><span /></span>}
                </>
              )}
              <button
                type="button"
                className="composer-attachment-remove"
                aria-label={`移除附件 ${item.file.name}`}
                title="移除附件"
                disabled={disabled}
                onClick={() => onRemove(item.id)}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
      {edges.right && (
        <button type="button" className="composer-rail-arrow is-right" aria-label="向右查看附件" onClick={() => page(1)}>
          <ChevronRight className="size-4" />
        </button>
      )}
      <Dialog open={Boolean(preview)} onOpenChange={(open) => { if (!open) setPreviewId(null); }}>
        <DialogContent className="w-fit max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-4rem)]" aria-describedby={undefined}>
          <DialogTitle className="truncate pr-8 text-sm">{preview?.file.name}</DialogTitle>
          {preview && <img src={preview.previewUrl} alt={preview.file.name} className="max-h-[75vh] max-w-full rounded-lg object-contain" />}
        </DialogContent>
      </Dialog>
    </div>
  );
}
