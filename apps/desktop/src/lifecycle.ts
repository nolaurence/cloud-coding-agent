import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

export const LOOPBACK_HOST = "127.0.0.1";

export function serverPortFromMessage(message: unknown): number | null {
  if (!message || typeof message !== "object") return null;
  const candidate = message as { type?: unknown; port?: unknown };
  if (
    candidate.type !== "cca-server-ready" ||
    typeof candidate.port !== "number" ||
    !Number.isInteger(candidate.port) ||
    candidate.port < 1 ||
    candidate.port > 65_535
  ) return null;
  return candidate.port;
}

export function waitForServerReady(child: ChildProcess, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let checkingHealth = false;
    let settled = false;
    const finish = (error: Error | null, origin?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
      controller.abort();
      if (error) reject(error);
      else resolve(origin!);
    };
    const onError = (error: Error) => finish(error);
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(new Error(`桌面服务在启动完成前退出（${signal ?? code ?? "unknown"}）`));
    };
    const onMessage = (message: unknown) => {
      const port = serverPortFromMessage(message);
      if (port === null || checkingHealth) return;
      checkingHealth = true;
      const origin = `http://${LOOPBACK_HOST}:${port}`;
      void waitForHttpReady(`${origin}/health`, { signal: controller.signal }).then(
        () => finish(null, origin),
        (error: Error) => finish(error),
      );
    };
    const timer = setTimeout(() => finish(new Error("等待桌面服务启动超时")), timeoutMs);
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("close", onClose);
  });
}

export function startupFailureDetail(error: unknown, output: string, logPath: string | null): string {
  return [
    error instanceof Error ? error.message : String(error),
    output.trim().slice(-4_000),
    logPath ? `完整启动日志：${logPath}` : "",
  ].filter(Boolean).join("\n\n");
}

export async function waitForHttpReady(
  url: string,
  options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Readiness wait aborted");
    try {
      const response = await fetch(url, { signal: options.signal });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs, undefined, { signal: options.signal });
  }
  throw new Error(`Server did not become ready within ${timeoutMs}ms`, { cause: lastError });
}

export function isAllowedExternalUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
