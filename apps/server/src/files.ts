import fs from "node:fs";
import path from "node:path";

const IGNORED = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".idea",
  ".vscode",
  "target",
  "__pycache__",
  ".pnpm-store",
]);

const MAX_RESULTS = 50;

export function searchFiles(rootPath: string, query: string): string[] {
  const results: string[] = [];
  const q = query.toLowerCase();
  const maxDepth = 8;

  function walk(dir: string, depth: number) {
    if (depth > maxDepth || results.length >= MAX_RESULTS * 4) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= MAX_RESULTS * 4) return;
      if (entry.isSymbolicLink() || IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootPath, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else {
        if (!q || rel.toLowerCase().includes(q)) {
          results.push(rel);
        }
      }
    }
  }

  walk(rootPath, 0);

  results.sort((a, b) => {
    if (!q) return a.localeCompare(b);
    const an = path.basename(a).toLowerCase();
    const bn = path.basename(b).toLowerCase();
    const aStarts = an.startsWith(q) ? 0 : 1;
    const bStarts = bn.startsWith(q) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return a.length - b.length;
  });

  return results.slice(0, MAX_RESULTS);
}
