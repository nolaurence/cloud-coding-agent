import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DshStatus {
  enabled: boolean;
  ready: boolean;
  starting: boolean;
  error?: string;
}

function authHeader(): Record<string, string> {
  const token = localStorage.getItem("cca-token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Waits for this user's DSH host, exchanges the CCA login for a one-shot DSH
 * portal ticket, then hands the browser over to the full-page UI at /dsh/.
 * Readiness is polled before the ticket is issued so a slow start never burns
 * a ticket or drops the user on a bare 503 page.
 */
export function DshPage() {
  const [status, setStatus] = useState<DshStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const enter = useCallback(async () => {
    const generationId = ++generation.current;
    const alive = () => generation.current === generationId;
    setError(null);
    try {
      let current: DshStatus | undefined;
      for (;;) {
        if (!alive()) return;
        const response = await fetch("/api/dsh/status", {
          headers: authHeader(),
          cache: "no-store",
        });
        current = (await response.json().catch(() => ({}))) as DshStatus & { error?: string };
        if (!response.ok) {
          throw new Error(current.error ?? `状态请求失败 (${response.status})`);
        }
        if (!alive()) return;
        setStatus(current);
        if (!current.enabled) throw new Error("DeepSeek Harness 已被部署配置禁用");
        if (current.ready) break;
        if (current.error && !current.starting) throw new Error(current.error);
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }

      if (!alive()) return;
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
      if (!alive()) return;
      window.location.replace(`/dsh/enter?ticket=${encodeURIComponent(ticket.ticket)}`);
    } catch (cause) {
      if (alive()) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  }, []);

  const retry = useCallback(async () => {
    // Wake a failed launch immediately instead of waiting out its backoff.
    await fetch("/api/dsh/retry", {
      method: "POST",
      headers: authHeader(),
    }).catch(() => undefined);
    void enter();
  }, [enter]);

  useEffect(() => {
    void enter();
    return () => {
      generation.current += 1;
    };
  }, [enter]);

  if (error) {
    return (
      <div className="flex h-dvh items-center justify-center p-6">
        <div className="w-full max-w-xl rounded-xl border border-amber-300/60 bg-amber-50/70 p-6 text-sm dark:border-amber-700/60 dark:bg-amber-950/30">
          <div className="mb-3 flex items-center gap-2 font-medium text-amber-800 dark:text-amber-200">
            <TriangleAlert className="h-5 w-5" />
            DeepSeek Harness 暂不可用
          </div>
          <p className="whitespace-pre-wrap break-words leading-6 text-amber-900/80 dark:text-amber-100/80">
            {error}
          </p>
          <Button type="button" variant="outline" className="mt-4" onClick={() => void retry()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            重试
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" />
      <span>{status?.starting ? "DeepSeek Harness 正在启动…" : "正在进入 DeepSeek Harness…"}</span>
    </div>
  );
}
