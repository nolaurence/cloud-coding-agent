function preferredSeparator(value: string): "/" | "\\" {
  if (/^[a-zA-Z]:/.test(value) || value.startsWith("\\\\")) return "\\";
  if (value.startsWith("/") || value.startsWith("~/")) return "/";
  return value.includes("\\") ? "\\" : "/";
}

function lastSeparatorIndex(value: string): number {
  if (value.startsWith("/")) return value.lastIndexOf("/");
  return Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
}

function splitPath(value: string): { root: string; separator: "/" | "\\"; segments: string[] } | null {
  const separator = preferredSeparator(value);
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    return {
      root: `~${separator}`,
      separator,
      segments: value.slice(1).split(/[\\/]+/).filter(Boolean),
    };
  }
  if (/^[a-zA-Z]:/.test(value)) {
    return {
      root: `${value.slice(0, 2)}${separator}`,
      separator,
      segments: value.slice(2).split(/[\\/]+/).filter(Boolean),
    };
  }
  if (value.startsWith("\\\\")) {
    const [server, share, ...segments] = value.split(/[\\/]+/).filter(Boolean);
    if (!server || !share) return null;
    return { root: `\\\\${server}\\${share}\\`, separator: "\\", segments };
  }
  if (value.startsWith("/")) {
    return { root: "/", separator: "/", segments: value.slice(1).split(/\/+/).filter(Boolean) };
  }
  return null;
}

function trimTrailingSeparators(value: string): string {
  if (value === "/" || /^[a-zA-Z]:[\\/]?$/.test(value)) return value;
  if (value === "~/" || value === "~\\") return "~";
  return value.replace(/[\\/]+$/, "");
}

export function hasTrailingPathSeparator(value: string): boolean {
  return /[\\/]$/.test(value);
}

export function getBrowseDirectoryPath(value: string): string {
  if (hasTrailingPathSeparator(value)) return value;
  const index = lastSeparatorIndex(value);
  return index < 0 ? value : value.slice(0, index + 1);
}

export function getBrowseLeaf(value: string): string {
  return value.slice(lastSeparatorIndex(value) + 1);
}

export function appendBrowsePath(value: string, segment: string): string {
  const separator = preferredSeparator(value);
  return `${getBrowseDirectoryPath(value)}${segment}${separator}`;
}

export function getBrowseParentPath(value: string): string | null {
  const split = splitPath(trimTrailingSeparators(value));
  if (!split || split.segments.length === 0) return null;
  if (split.segments.length === 1) return split.root;
  return `${split.root}${split.segments.slice(0, -1).join(split.separator)}${split.separator}`;
}

export function canNavigateUp(value: string): boolean {
  return hasTrailingPathSeparator(value) && getBrowseParentPath(value) !== null;
}

export function isBrowseDirectoryPath(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed === "~" ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("~\\") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\\\") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)
  );
}
