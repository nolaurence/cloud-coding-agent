import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DshStatus {
  enabled: boolean;
  ready: boolean;
  starting: boolean;
  error?: string;
  pid?: number;
  providerCount: number;
  modelCount: number;
  defaultModel?: { provider: string; model: string };
  sandboxHost?: string;
}

function authHeader(): Record<string, string> {
  const token = localStorage.getItem("cca-token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function DshPage() {
  const [status, setStatus] = useState<DshStatus | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const lastLaunch = useRef<string | null>(null);
  const srcRef = useRef<string | null>(null);
  const requestInFlight = useRef(false);

  const load = useCallback(async (knownStatus?: DshStatus, force = false) => {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    if (!srcRef.current) setLoading(true);
    setError(null);
    try {
      let next = knownStatus;
      if (!next) {
        const response = await fetch("/api/dsh/status", {
          headers: authHeader(),
          cache: "no-store",
        });
        next = (await response.json().catch(() => ({}))) as DshStatus & { error?: string };
        if (!response.ok) throw new Error(next.error ?? `状态请求失败 (${response.status})`);
        setStatus(next);
      }

      if (!next.enabled) throw new Error("DeepSeek Harness 已被部署配置禁用");
      if (!next.ready) {
        srcRef.current = null;
        lastLaunch.current = null;
        setSrc(null);
        setError(next.error && !next.starting ? next.error : null);
        setLoading(false);
        return;
      }

      const launchKey = `${next.pid ?? "unknown"}:${next.defaultModel?.provider ?? ""}:${next.defaultModel?.model ?? ""}`;
      if (!force && lastLaunch.current === launchKey && srcRef.current) {
        setLoading(false);
        return;
      }
      const ticketResponse = await fetch("/api/dsh/ticket", {
        method: "POST",
        headers: authHeader(),
      });
      const ticket = (await ticketResponse.json().catch(() => ({}))) as {
        ticket?: string;
        error?: string;
      };
      if (!ticketResponse.ok || !ticket.ticket) {
        throw new Error(ticket.error ?? `登录 DeepSeek Harness 失败 (${ticketResponse.status})`);
      }
      const nextSrc = `/dsh/enter?ticket=${encodeURIComponent(ticket.ticket)}`;
      lastLaunch.current = launchKey;
      srcRef.current = nextSrc;
      setSrc(nextSrc);
      setLoading(false);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
      setLoading(false);
    } finally {
      requestInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      try {
        const response = await fetch("/api/dsh/status", {
          headers: authHeader(),
          cache: "no-store",
        });
        const next = (await response.json().catch(() => ({}))) as DshStatus & { error?: string };
        if (!response.ok) throw new Error(next.error ?? `状态请求失败 (${response.status})`);
        if (stopped) return;
        setStatus(next);
        await load(next);
      } catch (pollError) {
        if (stopped || srcRef.current) return;
        setError(pollError instanceof Error ? pollError.message : String(pollError));
        setLoading(false);
      }
    };
    const timer = window.setInterval(() => void tick(), 5_000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [load]);

  if (loading && !src) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span>{status?.starting ? "DeepSeek Harness 正在启动…" : "正在连接 DeepSeek Harness…"}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="w-full max-w-xl rounded-xl border border-amber-300/60 bg-amber-50/70 p-6 text-sm dark:border-amber-700/60 dark:bg-amber-950/30">
          <div className="mb-3 flex items-center gap-2 font-medium text-amber-800 dark:text-amber-200">
            <TriangleAlert className="h-5 w-5" />
            DeepSeek Harness 暂不可用
          </div>
          <p className="whitespace-pre-wrap break-words leading-6 text-amber-900/80 dark:text-amber-100/80">
            {error}
          </p>
          <Button type="button" variant="outline" className="mt-4" onClick={() => void load(undefined, true)}>
            <RefreshCw className="mr-2 h-4 w-4" />
            重试
          </Button>
        </div>
      </div>
    );
  }

  if (!status?.ready || !src) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        <span>DeepSeek Harness 正在启动…</span>
      </div>
    );
  }

  return (
    <iframe
      key={src}
      src={src}
      title="DeepSeek Harness"
      className="h-full w-full border-0 bg-background"
      allow="clipboard-read; clipboard-write"
    />
  );
}
