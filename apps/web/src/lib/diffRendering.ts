import { parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

export const DIFF_THEME_NAMES = {
  light: "pierre-light",
  dark: "pierre-dark",
} as const;

export type DiffThemeName = (typeof DIFF_THEME_NAMES)[keyof typeof DIFF_THEME_NAMES];

export function resolveDiffThemeName(theme: "light" | "dark"): DiffThemeName {
  return theme === "dark" ? DIFF_THEME_NAMES.dark : DIFF_THEME_NAMES.light;
}

function fnv1a32(input: string, seed: number, multiplier: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

export function buildPatchCacheKey(patch: string, scope = "workspace-diff"): string {
  const normalized = patch.trim();
  const primary = fnv1a32(normalized, 0x811c9dc5, 0x01000193).toString(36);
  const secondary = fnv1a32(normalized, 0x9e3779b9, 0x85ebca6b).toString(36);
  return `${scope}:${normalized.length}:${primary}:${secondary}`;
}

export type RenderablePatch =
  | { kind: "files"; files: FileDiffMetadata[] }
  | { kind: "raw"; text: string; reason: string };

function compactPartialHunkOffsets(file: FileDiffMetadata): FileDiffMetadata {
  if (!file.isPartial) return file;

  let splitLineStart = 0;
  let unifiedLineStart = 0;
  const hunks = file.hunks.map((hunk) => {
    const compactHunk = { ...hunk, splitLineStart, unifiedLineStart };
    splitLineStart += hunk.splitLineCount;
    unifiedLineStart += hunk.unifiedLineCount;
    return compactHunk;
  });

  return {
    ...file,
    hunks,
    splitLineCount: splitLineStart,
    unifiedLineCount: unifiedLineStart,
    ...(file.cacheKey ? { cacheKey: `${file.cacheKey}:compact` } : {}),
  };
}

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = "workspace-diff",
): RenderablePatch | null {
  const normalized = patch?.trim();
  if (!normalized) return null;

  try {
    const files = parsePatchFiles(
      normalized,
      buildPatchCacheKey(normalized, cacheScope),
    ).flatMap((parsed) => parsed.files.map(compactPartialHunkOffsets));
    if (files.length > 0) return { kind: "files", files };
    return { kind: "raw", text: normalized, reason: "暂不支持该差异格式，已显示原始补丁。" };
  } catch {
    return { kind: "raw", text: normalized, reason: "差异解析失败，已显示原始补丁。" };
  }
}

export function resolveFileDiffPath(file: FileDiffMetadata): string {
  const raw = file.name || file.prevName || "";
  return raw.startsWith("a/") || raw.startsWith("b/") ? raw.slice(2) : raw;
}

export function buildFileDiffRenderKey(file: FileDiffMetadata): string {
  return file.cacheKey ?? `${file.prevName ?? "none"}:${file.name}`;
}
