import { useEffect, useState } from "react";
import { ArrowLeft, Link2Off, Loader2, LogIn, RefreshCw } from "lucide-react";
import type { ThreadSharePreview } from "@cca/protocol";
import { useNavigate, useParams } from "react-router-dom";
import { ChatView } from "../components/ChatView";
import { BrandLogo } from "../components/BrandLogo";
import { Button } from "@/components/ui/button";
import { useApp } from "../lib/store";

export function ShareThreadPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const connected = useApp((state) => state.connected);
  const previewThreadShare = useApp((state) => state.previewThreadShare);
  const redeemThreadShare = useApp((state) => state.redeemThreadShare);
  const closeThread = useApp((state) => state.closeThread);
  const [preview, setPreview] = useState<ThreadSharePreview | null>(null);
  const [joining, setJoining] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setError("分享链接不完整");
      return;
    }
    if (!connected) return;
    let cancelled = false;
    let previewThreadId = "";
    setPreview(null);
    setError("");
    void previewThreadShare(token)
      .then((result) => {
        previewThreadId = result.thread.id;
        if (cancelled) {
          void closeThread(result.thread.id);
          return;
        }
        setPreview(result);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法打开分享会话");
      });
    return () => {
      cancelled = true;
      if (previewThreadId) void closeThread(previewThreadId);
    };
  }, [closeThread, connected, previewThreadShare, retry, token]);

  const join = async () => {
    if (!token || joining) return;
    setJoining(true);
    setError("");
    try {
      const thread = await redeemThreadShare(token);
      navigate(`/thread/${thread.id}`, { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "无法加入分享会话");
      setJoining(false);
    }
  };

  if (preview && token) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3 sm:px-5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="返回首页"
            title="返回首页"
            onClick={() => navigate("/", { replace: true })}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <BrandLogo className="h-6 w-6 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{preview.thread.title}</div>
            <div className="text-xs text-muted-foreground">
              {preview.mode === "collaborate"
                ? "只读预览 · 加入后可发送消息"
                : "只读预览 · 分享者仅允许查看"}
            </div>
          </div>
          <Button type="button" onClick={() => void join()} disabled={joining}>
            {joining ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
            加入会话
          </Button>
        </header>
        {error && (
          <div className="shrink-0 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-center text-sm text-destructive" role="alert">
            {error}
          </div>
        )}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <ChatView
            threadId={preview.thread.id}
            shareToken={token}
            manageSubscription={false}
            showAuthors
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-[24rem] items-center justify-center bg-background px-6">
      <div className="flex w-full max-w-sm flex-col items-center text-center">
        <BrandLogo className="mb-5 h-12 w-12" />
        {error ? (
          <>
            <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
              <Link2Off className="h-5 w-5" />
            </div>
            <h1 className="text-base font-semibold">无法打开分享会话</h1>
            <p className="mt-2 text-sm text-muted-foreground" role="alert">{error}</p>
            <div className="mt-5 flex gap-2">
              <Button type="button" variant="outline" onClick={() => navigate("/", { replace: true })}>
                <ArrowLeft className="h-4 w-4" />
                返回首页
              </Button>
              <Button type="button" onClick={() => setRetry((value) => value + 1)}>
                <RefreshCw className="h-4 w-4" />
                重试
              </Button>
            </div>
          </>
        ) : (
          <>
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <h1 className="mt-4 text-base font-semibold">
              {connected ? "正在加载分享会话" : "正在连接服务器"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">打开后可先只读查看消息</p>
          </>
        )}
      </div>
    </div>
  );
}
