import { useEffect, useState } from "react";
import { ArrowLeft, Link2Off, Loader2, RefreshCw } from "lucide-react";
import { useNavigate, useParams } from "react-router-dom";
import { useApp } from "../lib/store";
import { BrandLogo } from "../components/BrandLogo";
import { Button } from "@/components/ui/button";

export function ShareThreadPage() {
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const connected = useApp((state) => state.connected);
  const redeemThreadShare = useApp((state) => state.redeemThreadShare);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) {
      setError("分享链接不完整");
      return;
    }
    if (!connected) return;
    let cancelled = false;
    setError("");
    void redeemThreadShare(token)
      .then((thread) => {
        if (!cancelled) navigate(`/thread/${thread.id}`, { replace: true });
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : "无法加入分享会话");
      });
    return () => {
      cancelled = true;
    };
  }, [connected, navigate, redeemThreadShare, retry, token]);

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
            <p className="mt-2 text-sm text-muted-foreground" role="alert">
              {error}
            </p>
            <div className="mt-5 flex gap-2">
              <Button type="button" variant="outline" onClick={() => navigate("/", { replace: true })}>
                <ArrowLeft className="h-4 w-4" />
                返回首页
              </Button>
              {token && (
                <Button
                  type="button"
                  onClick={() => {
                    setRetry((value) => value + 1);
                  }}
                >
                  <RefreshCw className="h-4 w-4" />
                  重试
                </Button>
              )}
            </div>
          </>
        ) : (
          <>
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <h1 className="mt-4 text-base font-semibold">
              {connected ? "正在加入分享会话" : "正在连接服务器"}
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">请稍候</p>
          </>
        )}
      </div>
    </div>
  );
}
