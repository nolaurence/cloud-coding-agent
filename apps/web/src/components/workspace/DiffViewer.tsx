import { useMemo, useState } from "react";
import type { CodeViewDiffItem, FileDiffMetadata } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { ChevronDown, ChevronRight, Columns2, Rows3, WrapText } from "lucide-react";
import { Button } from "../ui/button";
import {
  buildFileDiffRenderKey,
  buildPatchCacheKey,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../../lib/diffRendering";
import { useTheme } from "../../lib/theme";
import { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

const DIFF_VIEWER_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-sans) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-bg: var(--background) !important;
  --diffs-light-bg: var(--background) !important;
  --diffs-dark-bg: var(--background) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;
  --diffs-bg-context-override: color-mix(in srgb, var(--background) 97%, var(--foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--background) 94%, var(--foreground));
  --diffs-bg-separator-override: color-mix(in srgb, var(--background) 95%, var(--foreground));
  --diffs-bg-buffer-override: color-mix(in srgb, var(--background) 92%, var(--foreground));
  --diffs-bg-addition-override: color-mix(in srgb, var(--background) 90%, oklch(0.62 0.17 145));
  --diffs-bg-addition-number-override: color-mix(in srgb, var(--background) 84%, oklch(0.62 0.17 145));
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--background) 80%, oklch(0.62 0.17 145));
  --diffs-bg-addition-emphasis-override: color-mix(in srgb, var(--background) 74%, oklch(0.62 0.17 145));
  --diffs-bg-deletion-override: color-mix(in srgb, var(--background) 91%, var(--destructive));
  --diffs-bg-deletion-number-override: color-mix(in srgb, var(--background) 85%, var(--destructive));
  --diffs-bg-deletion-hover-override: color-mix(in srgb, var(--background) 81%, var(--destructive));
  --diffs-bg-deletion-emphasis-override: color-mix(in srgb, var(--background) 75%, var(--destructive));
  background-color: var(--diffs-bg) !important;
}
[data-file-info],
[data-diffs-header] {
  background-color: color-mix(in srgb, var(--background) 94%, var(--foreground)) !important;
  border-color: var(--border) !important;
  color: var(--foreground) !important;
}
[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  min-height: 32px !important;
  padding-block: 6px !important;
  border-bottom: 1px solid var(--border) !important;
  font-family: var(--font-sans) !important;
  font-size: 12px !important;
  line-height: 1 !important;
}
[data-diffs-header] [data-header-content],
[data-diffs-header] [data-metadata] {
  align-items: center !important;
  line-height: 1 !important;
}
[data-diffs-header] [data-additions-count],
[data-diffs-header] [data-deletions-count] {
  font-family: var(--font-mono) !important;
  font-size: 11px !important;
  font-variant-numeric: tabular-nums;
}
[data-title] {
  font-family: var(--font-sans) !important;
}
`;

interface DiffViewerProps {
  patch?: string;
  loading: boolean;
  truncated: boolean;
  untrackedFiles: readonly string[];
  untrackedTotal: number;
}

type ViewMode = "unified" | "split";
const EMPTY_KEYS: ReadonlySet<string> = new Set();

function fileColor(file: FileDiffMetadata): string {
  if (file.type === "new") return "text-emerald-600 dark:text-emerald-400";
  if (file.type === "deleted") return "text-red-600 dark:text-red-400";
  return "text-amber-600 dark:text-amber-400";
}

export function DiffViewer({
  patch,
  loading,
  truncated,
  untrackedFiles,
  untrackedTotal,
}: DiffViewerProps) {
  const { resolvedTheme } = useTheme();
  const [viewMode, setViewMode] = useState<ViewMode>("unified");
  const [wordWrap, setWordWrap] = useState(false);
  const scopeKey = useMemo(() => buildPatchCacheKey(patch ?? ""), [patch]);
  const [collapseState, setCollapseState] = useState<{
    scopeKey: string;
    keys: ReadonlySet<string>;
  }>({ scopeKey, keys: new Set() });
  const collapsedKeys = collapseState.scopeKey === scopeKey ? collapseState.keys : EMPTY_KEYS;
  const renderable = useMemo(
    () => getRenderablePatch(patch, `workspace-diff:${resolvedTheme}`),
    [patch, resolvedTheme],
  );
  const files = useMemo(() => {
    if (renderable?.kind !== "files") return [];
    return [...renderable.files].sort((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderable]);
  const items = useMemo<CodeViewDiffItem[]>(
    () => files.map((fileDiff) => {
      const id = buildFileDiffRenderKey(fileDiff);
      const collapsed = collapsedKeys.has(id);
      return { id, type: "diff", fileDiff, collapsed, version: collapsed ? 1 : 0 };
    }),
    [collapsedKeys, files],
  );
  const renderedPaths = useMemo(
    () => new Set(files.map(resolveFileDiffPath)),
    [files],
  );
  const unrenderedUntrackedFiles = untrackedFiles.filter((file) => !renderedPaths.has(file));
  const unrenderedUntrackedCount =
    unrenderedUntrackedFiles.length + Math.max(0, untrackedTotal - untrackedFiles.length);

  const toggleCollapsed = (id: string) => {
    setCollapseState((current) => {
      const keys = new Set(current.scopeKey === scopeKey ? current.keys : []);
      if (keys.has(id)) keys.delete(id);
      else keys.add(id);
      return { scopeKey, keys };
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {truncated && (
        <div className="shrink-0 border-b border-amber-200 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800 dark:border-amber-950 dark:bg-amber-950/30 dark:text-amber-300">
          差异过大，仅展示前 2 MB 内容。
        </div>
      )}
      {renderable && (
        <div className="flex h-9 shrink-0 items-center justify-end gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800">
          <Button
            type="button"
            variant={viewMode === "unified" ? "secondary" : "ghost"}
            size="icon-xs"
            aria-label="统一视图"
            title="统一视图"
            aria-pressed={viewMode === "unified"}
            onClick={() => setViewMode("unified")}
          >
            <Rows3 />
          </Button>
          <Button
            type="button"
            variant={viewMode === "split" ? "secondary" : "ghost"}
            size="icon-xs"
            aria-label="左右分栏"
            title="左右分栏"
            aria-pressed={viewMode === "split"}
            onClick={() => setViewMode("split")}
          >
            <Columns2 />
          </Button>
          <Button
            type="button"
            variant={wordWrap ? "secondary" : "ghost"}
            size="icon-xs"
            aria-label={wordWrap ? "关闭自动换行" : "开启自动换行"}
            title={wordWrap ? "关闭自动换行" : "开启自动换行"}
            aria-pressed={wordWrap}
            onClick={() => setWordWrap((value) => !value)}
          >
            <WrapText />
          </Button>
        </div>
      )}
      {renderable && unrenderedUntrackedCount > 0 && (
        <details className="shrink-0 border-b border-zinc-200 bg-zinc-50 px-3 py-1.5 text-[11px] text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/50 dark:text-zinc-400">
          <summary className="cursor-pointer">
            另有 {unrenderedUntrackedCount} 个未跟踪文件无法生成文本差异
          </summary>
          <div className="mt-1 max-h-24 overflow-auto font-mono">
            {unrenderedUntrackedFiles.map((file) => <div key={file} className="truncate">{file}</div>)}
            {untrackedTotal > untrackedFiles.length && (
              <div>…另有 {untrackedTotal - untrackedFiles.length} 个文件</div>
            )}
          </div>
        </details>
      )}
      {!renderable ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-6 text-center text-xs text-zinc-500">
          {loading ? (
            "正在读取 Git 差异…"
          ) : untrackedTotal > 0 ? (
            <div className="max-w-full space-y-2">
              <p>没有可预览的 UTF-8 文本差异</p>
              <div className="max-h-48 overflow-auto rounded-md border border-zinc-200 p-2 text-left font-mono dark:border-zinc-800">
                {untrackedFiles.map((file) => <div key={file} className="truncate">{file}</div>)}
                {untrackedTotal > untrackedFiles.length && (
                  <div>…另有 {untrackedTotal - untrackedFiles.length} 个文件</div>
                )}
              </div>
            </div>
          ) : (
            "暂无未提交差异"
          )}
        </div>
      ) : renderable.kind === "raw" ? (
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <p className="mb-2 text-[11px] text-zinc-500">{renderable.reason}</p>
          <pre className={`rounded-md border border-zinc-200 p-3 font-mono text-[11px] leading-5 dark:border-zinc-800 ${wordWrap ? "whitespace-pre-wrap break-words" : "overflow-auto whitespace-pre"}`}>
            {renderable.text}
          </pre>
        </div>
      ) : (
        <DiffWorkerPoolProvider>
          <CodeView
            className="workspace-diff-viewer min-h-0 flex-1 overflow-auto"
            items={items}
            options={{
              diffStyle: viewMode,
              lineDiffType: "none",
              overflow: wordWrap ? "wrap" : "scroll",
              theme: resolveDiffThemeName(resolvedTheme),
              themeType: resolvedTheme,
              unsafeCSS: DIFF_VIEWER_CSS,
              stickyHeaders: true,
              layout: { paddingTop: 8, paddingBottom: 8, gap: 8 },
            }}
            renderHeaderPrefix={(item) => {
              if (item.type !== "diff") return null;
              const collapsed = item.collapsed === true;
              const filePath = resolveFileDiffPath(item.fileDiff);
              return (
                <button
                  type="button"
                  className={`inline-flex size-5 shrink-0 items-center justify-center rounded-sm hover:bg-zinc-500/10 ${fileColor(item.fileDiff)}`}
                  aria-label={collapsed ? `展开 ${filePath}` : `折叠 ${filePath}`}
                  aria-expanded={!collapsed}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleCollapsed(item.id);
                  }}
                >
                  {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                </button>
              );
            }}
          />
        </DiffWorkerPoolProvider>
      )}
    </div>
  );
}
