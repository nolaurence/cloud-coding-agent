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
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(options.signal?.reason ?? new Error("Readiness wait aborted"));
      }, { once: true });
    });
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
