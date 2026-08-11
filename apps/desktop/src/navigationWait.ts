import type { WebContents } from "electron";

export const NAVIGATION_START_GRACE_MS = 250;
export const NAVIGATION_SETTLE_TIMEOUT_MS = 10_000;

interface NavigationEvents {
  on(event: "did-start-navigation", listener: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void): unknown;
  off(event: "did-start-navigation", listener: (event: unknown, url: string, isInPlace: boolean, isMainFrame: boolean) => void): unknown;
  on(event: "did-stop-loading", listener: () => void): unknown;
  off(event: "did-stop-loading", listener: () => void): unknown;
  isLoadingMainFrame(): boolean;
}

export function waitForNavigationAfter(
  contents: NavigationEvents,
  trigger: () => void | Promise<void>,
  options: { requireNavigation?: boolean; startGraceMs?: number; settleTimeoutMs?: number } = {},
): Promise<void> {
  const requireNavigation = options.requireNavigation ?? false;
  const grace = requireNavigation ? options.settleTimeoutMs ?? NAVIGATION_SETTLE_TIMEOUT_MS : options.startGraceMs ?? NAVIGATION_START_GRACE_MS;
  const settleTimeout = options.settleTimeoutMs ?? NAVIGATION_SETTLE_TIMEOUT_MS;
  return new Promise<void>((resolve, reject) => {
    let started = contents.isLoadingMainFrame();
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let startTimer: ReturnType<typeof setTimeout>;
    const cleanup = () => { clearTimeout(startTimer); if (settleTimer) clearTimeout(settleTimer); contents.off("did-start-navigation", onStart); contents.off("did-stop-loading", onStop); };
    const finish = (error?: Error) => { cleanup(); error ? reject(error) : resolve(); };
    const onStart = (_event: unknown, _url: string, _isInPlace: boolean, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      started = true;
      clearTimeout(startTimer);
      settleTimer = setTimeout(() => finish(new Error("Browser navigation timed out")), settleTimeout);
    };
    const onStop = () => { if (started) finish(); };
    contents.on("did-start-navigation", onStart);
    contents.on("did-stop-loading", onStop);
    startTimer = setTimeout(() => {
      if (!started && !requireNavigation) finish();
      else if (!started) finish(new Error("Browser navigation did not start"));
      else settleTimer = setTimeout(() => finish(new Error("Browser navigation timed out")), settleTimeout);
    }, grace);
    Promise.resolve().then(trigger).then(() => {
      if (contents.isLoadingMainFrame() && !started) onStart(undefined, "", false, true);
    }, (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

export type NavigationWebContents = Pick<WebContents, "on" | "off" | "isLoadingMainFrame">;
