import { useEffect, useState } from "react";
import { ImageOff, LoaderCircle, RefreshCw } from "lucide-react";
import { loadProjectImage } from "../../lib/client";
import { Button } from "@/components/ui/button";

interface ImageState {
  src: string;
  loading: boolean;
  error: string;
}

export function ProjectImagePreview({ projectId, path }: { projectId: string; path: string }) {
  const [state, setState] = useState<ImageState>({ src: "", loading: true, error: "" });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let objectUrl = "";
    setState({ src: "", loading: true, error: "" });

    void loadProjectImage(projectId, path, controller.signal)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = "";
          return;
        }
        setState({ src: objectUrl, loading: false, error: "" });
      })
      .catch((reason: unknown) => {
        if (!active || (reason instanceof DOMException && reason.name === "AbortError")) return;
        setState({
          src: "",
          loading: false,
          error: reason instanceof Error ? reason.message : "图片加载失败",
        });
      });

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, projectId, reload]);

  if (state.loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-zinc-500">
        <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />加载图片中…
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <ImageOff className="h-5 w-5 text-red-500" />
        <div className="max-w-sm text-xs text-red-600 dark:text-red-400">{state.error}</div>
        <Button type="button" variant="outline" size="sm" onClick={() => setReload((value) => value + 1)}>
          <RefreshCw className="mr-1.5 h-3.5 w-3.5" />重试
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-zinc-100/70 p-6 dark:bg-zinc-900/70">
      <img
        src={state.src}
        alt={path.split("/").at(-1) ?? path}
        draggable={false}
        decoding="async"
        className="max-h-full max-w-full rounded-sm object-contain shadow-sm"
      />
    </div>
  );
}
