import { useCallback, useEffect, useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "cca-theme";
export const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: "system", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
];

const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const LIGHT_BACKGROUND = "#ffffff";
const DARK_BACKGROUND = "#09090b";

interface ThemeSnapshot {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

const SERVER_SNAPSHOT: ThemeSnapshot = { preference: "system", resolved: "light" };
const listeners = new Set<() => void>();
let lastSnapshot: ThemeSnapshot | undefined;

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MEDIA_QUERY).matches;
}

export function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : "system";
  } catch {
    return "system";
  }
}

export function resolveTheme(
  preference: ThemePreference,
  prefersDark = systemPrefersDark(),
): ResolvedTheme {
  if (preference !== "system") return preference;
  return prefersDark ? "dark" : "light";
}

function syncBrowserTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const background = resolved === "dark" ? DARK_BACKGROUND : LIGHT_BACKGROUND;
  document.documentElement.style.backgroundColor = background;
  document.body?.style.setProperty("background-color", background);
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", background);
}

export function applyTheme(preference: ThemePreference, suppressTransitions = false): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const resolved = resolveTheme(preference);
  if (suppressTransitions) root.classList.add("no-transitions");
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = preference;
  syncBrowserTheme(resolved);
  if (suppressTransitions) {
    void root.offsetHeight;
    window.requestAnimationFrame(() => root.classList.remove("no-transitions"));
  }
}

function getSnapshot(): ThemeSnapshot {
  const preference = readThemePreference();
  const resolved = resolveTheme(preference);
  if (lastSnapshot?.preference === preference && lastSnapshot.resolved === resolved) {
    return lastSnapshot;
  }
  lastSnapshot = { preference, resolved };
  return lastSnapshot;
}

function getServerSnapshot(): ThemeSnapshot {
  return SERVER_SNAPSHOT;
}

function emitChange(): void {
  lastSnapshot = undefined;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  listeners.add(listener);
  const mediaQuery = window.matchMedia?.(MEDIA_QUERY);
  const onSystemThemeChange = () => {
    if (readThemePreference() === "system") {
      applyTheme("system", true);
      emitChange();
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== THEME_STORAGE_KEY && event.key !== null) return;
    applyTheme(readThemePreference(), true);
    emitChange();
  };
  mediaQuery?.addEventListener("change", onSystemThemeChange);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    mediaQuery?.removeEventListener("change", onSystemThemeChange);
    window.removeEventListener("storage", onStorage);
  };
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  applyTheme(readThemePreference());
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setTheme = useCallback((preference: ThemePreference) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, preference);
    } catch (error) {
      console.error("无法保存主题设置", error);
      return;
    }
    applyTheme(preference, true);
    emitChange();
  }, []);

  useEffect(() => {
    applyTheme(snapshot.preference);
  }, [snapshot.preference]);

  return {
    theme: snapshot.preference,
    resolvedTheme: snapshot.resolved,
    setTheme,
  } as const;
}
