/** 与 t3code `deriveProjectIdentity` 对齐的仓库徽标：双字母缩写 + 名字哈希色。 */

export const PROJECT_ICON_COLORS = [
  {
    value: "gray",
    bgClassName: "bg-gray-100 dark:bg-gray-800/80",
    textClassName: "text-gray-600 dark:text-gray-300",
  },
  {
    value: "red",
    bgClassName: "bg-red-100 dark:bg-red-950/70",
    textClassName: "text-red-600 dark:text-red-400",
  },
  {
    value: "orange",
    bgClassName: "bg-orange-100 dark:bg-orange-950/70",
    textClassName: "text-orange-700 dark:text-orange-400",
  },
  {
    value: "amber",
    bgClassName: "bg-amber-100 dark:bg-amber-950/70",
    textClassName: "text-amber-700 dark:text-amber-400",
  },
  {
    value: "yellow",
    bgClassName: "bg-yellow-100 dark:bg-yellow-950/70",
    textClassName: "text-yellow-700 dark:text-yellow-400",
  },
  {
    value: "lime",
    bgClassName: "bg-lime-100 dark:bg-lime-950/70",
    textClassName: "text-lime-700 dark:text-lime-400",
  },
  {
    value: "green",
    bgClassName: "bg-green-100 dark:bg-green-950/70",
    textClassName: "text-green-700 dark:text-green-400",
  },
  {
    value: "emerald",
    bgClassName: "bg-emerald-100 dark:bg-emerald-950/70",
    textClassName: "text-emerald-700 dark:text-emerald-400",
  },
  {
    value: "teal",
    bgClassName: "bg-teal-100 dark:bg-teal-950/70",
    textClassName: "text-teal-700 dark:text-teal-400",
  },
  {
    value: "cyan",
    bgClassName: "bg-cyan-100 dark:bg-cyan-950/70",
    textClassName: "text-cyan-700 dark:text-cyan-400",
  },
  {
    value: "sky",
    bgClassName: "bg-sky-100 dark:bg-sky-950/70",
    textClassName: "text-sky-700 dark:text-sky-400",
  },
  {
    value: "blue",
    bgClassName: "bg-blue-100 dark:bg-blue-950/70",
    textClassName: "text-blue-700 dark:text-blue-400",
  },
  {
    value: "indigo",
    bgClassName: "bg-indigo-100 dark:bg-indigo-950/70",
    textClassName: "text-indigo-700 dark:text-indigo-400",
  },
  {
    value: "violet",
    bgClassName: "bg-violet-100 dark:bg-violet-950/70",
    textClassName: "text-violet-700 dark:text-violet-400",
  },
  {
    value: "purple",
    bgClassName: "bg-purple-100 dark:bg-purple-950/70",
    textClassName: "text-purple-700 dark:text-purple-400",
  },
  {
    value: "fuchsia",
    bgClassName: "bg-fuchsia-100 dark:bg-fuchsia-950/70",
    textClassName: "text-fuchsia-700 dark:text-fuchsia-400",
  },
  {
    value: "pink",
    bgClassName: "bg-pink-100 dark:bg-pink-950/70",
    textClassName: "text-pink-700 dark:text-pink-400",
  },
  {
    value: "rose",
    bgClassName: "bg-rose-100 dark:bg-rose-950/70",
    textClassName: "text-rose-700 dark:text-rose-400",
  },
] as const;

export type ProjectIconColor = (typeof PROJECT_ICON_COLORS)[number]["value"];

export interface ProjectIdentity {
  monogram: string;
  color: ProjectIconColor;
  bgClassName: string;
  textClassName: string;
}

function normalizeProjectName(projectName: string): string {
  return projectName.normalize("NFKC").trim();
}

function projectMonogram(projectName: string): string {
  const words = normalizeProjectName(projectName).match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0];
  if (!firstWord) return "PR";

  const glyphs = Array.from(firstWord);
  const first = glyphs[0] ?? "P";
  const second =
    glyphs.slice(1).find((glyph) => /\p{N}/u.test(glyph)) ??
    (words.length > 1 ? Array.from(words.at(-1) ?? "")[0] : glyphs.at(-1)) ??
    first;
  return Array.from(`${first}${second}`.toUpperCase()).slice(0, 2).join("");
}

function projectColorIndex(projectName: string): number {
  const seed = normalizeProjectName(projectName).toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % PROJECT_ICON_COLORS.length;
  }
  return index;
}

export function deriveProjectIdentity(projectName: string): ProjectIdentity {
  const swatch = PROJECT_ICON_COLORS[projectColorIndex(projectName)] ?? PROJECT_ICON_COLORS[11];
  return {
    monogram: projectMonogram(projectName),
    color: swatch.value,
    bgClassName: swatch.bgClassName,
    textClassName: swatch.textClassName,
  };
}
