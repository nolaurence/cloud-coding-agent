export const CODEX_RECONNECT_DELAYS_MS = [0, 1_000, 2_000, 4_000, 8_000] as const;

interface ReconnectOptions {
  delays?: readonly number[];
  sleep?: (milliseconds: number) => Promise<void>;
  cancelled?: () => boolean;
}

function sleep(milliseconds: number): Promise<void> {
  return milliseconds > 0
    ? new Promise((resolve) => setTimeout(resolve, milliseconds))
    : Promise.resolve();
}

export async function retryCodexReconnect<T>(
  attempt: (attempt: number) => Promise<T>,
  options: ReconnectOptions = {},
): Promise<T> {
  const delays = options.delays ?? CODEX_RECONNECT_DELAYS_MS;
  const wait = options.sleep ?? sleep;
  let lastError: unknown;
  for (let index = 0; index < delays.length; index++) {
    await wait(delays[index]!);
    if (options.cancelled?.()) throw new Error("Codex reconnect cancelled");
    try {
      return await attempt(index);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Codex reconnect failed");
}
