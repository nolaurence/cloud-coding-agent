import { useEffect, useState } from "react";
import { loadImage } from "../lib/client";
import type { ImagePreviewTarget } from "../lib/imagePreview";

interface ImageObjectUrlState {
  src: string;
  loading: boolean;
  error: string;
}

export function useImageObjectUrl({
  id,
  threadId,
  shareToken,
}: ImagePreviewTarget): ImageObjectUrlState {
  const [state, setState] = useState<ImageObjectUrlState>({
    src: "",
    loading: true,
    error: "",
  });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let objectUrl = "";
    setState({ src: "", loading: true, error: "" });

    void loadImage(id, threadId, controller.signal, shareToken)
      .then((blob) => {
        objectUrl = URL.createObjectURL(blob);
        if (!active) {
          URL.revokeObjectURL(objectUrl);
          objectUrl = "";
          return;
        }
        setState({ src: objectUrl, loading: false, error: "" });
      })
      .catch((error: unknown) => {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
        setState({
          src: "",
          loading: false,
          error: error instanceof Error ? error.message : "图片加载失败",
        });
      });

    return () => {
      active = false;
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, shareToken, threadId]);

  return state;
}
