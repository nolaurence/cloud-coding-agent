import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  FileCode2,
  Folder,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import type {
  ProjectDirectoryEntry,
  ProjectDirectoryListing,
  ProjectFileContent,
  ProjectFileEntry,
} from "@cca/protocol";
import { request } from "../../lib/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type DirectoryChildren = Record<string, ProjectDirectoryEntry[]>;

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error ? reason.message : fallback;
}

function baseName(path: string) {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function parentPath(path: string) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function sortEntries(entries: readonly ProjectDirectoryEntry[]) {
  return [...entries].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
}

function flatEntriesToChildren(entries: readonly ProjectFileEntry[]): DirectoryChildren {
  const children: DirectoryChildren = {};
  for (const entry of entries) {
    const parent = parentPath(entry.path);
    const value: ProjectDirectoryEntry = {
      ...entry,
      name: baseName(entry.path),
      modifiedAt: 0,
    };
    children[parent] = [...(children[parent] ?? []), value];
  }
  for (const [directory, values] of Object.entries(children)) {
    children[directory] = sortEntries(values);
  }
  return children;
}

function formatBytes(size: number) {
  if (size < 1_024) return `${size} B`;
  if (size < 1_024 * 1_024) return `${(size / 1_024).toFixed(size < 10_240 ? 1 : 0)} KB`;
  return `${(size / (1_024 * 1_024)).toFixed(1)} MB`;
}

export function FilesPanel({ projectId }: { projectId: string }) {
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const treeGenerationRef = useRef(0);
  const searchRequestRef = useRef(0);
  const previewRequestRef = useRef(0);
  const [children, setChildren] = useState<DirectoryChildren>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadingDirectories, setLoadingDirectories] = useState<Set<string>>(new Set([""]));
  const [treeError, setTreeError] = useState("");
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<string[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchRefresh, setSearchRefresh] = useState(0);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selected, setSelected] = useState<ProjectFileContent | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");

  const loadDirectory = useCallback(async (
    directory: string,
    replace = false,
    generation = treeGenerationRef.current,
  ) => {
    const requestProject = projectId;
    setLoadingDirectories((current) => new Set(current).add(directory));
    if (!directory) setTreeError("");
    try {
      try {
        const listing = await request<ProjectDirectoryListing>({
          type: "project.directory.list",
          projectId: requestProject,
          path: directory || undefined,
        });
        if (projectRef.current !== requestProject || treeGenerationRef.current !== generation) return false;
        setChildren((current) => ({
          ...(replace ? {} : current),
          [directory]: sortEntries(listing.entries),
        }));
      } catch (directoryError) {
        if (directory) throw directoryError;
        const flatEntries = await request<ProjectFileEntry[]>({ type: "project.files", projectId: requestProject });
        if (projectRef.current !== requestProject || treeGenerationRef.current !== generation) return false;
        setChildren(flatEntriesToChildren(flatEntries));
      }
      return true;
    } catch (reason) {
      if (projectRef.current === requestProject && treeGenerationRef.current === generation) {
        setTreeError(errorMessage(reason, "文件列表加载失败"));
      }
      return false;
    } finally {
      if (projectRef.current === requestProject && treeGenerationRef.current === generation) {
        setLoadingDirectories((current) => {
          const next = new Set(current);
          next.delete(directory);
          return next;
        });
      }
    }
  }, [projectId]);

  useEffect(() => {
    const generation = ++treeGenerationRef.current;
    ++previewRequestRef.current;
    setChildren({});
    setExpanded(new Set());
    setLoadingDirectories(new Set([""]));
    setTreeError("");
    setQuery("");
    setSearchResults(null);
    setSelectedPath(null);
    setSelected(null);
    setPreviewError("");
    void loadDirectory("", true, generation);
  }, [loadDirectory]);

  useEffect(() => {
    const normalized = query.trim();
    if (!normalized) {
      ++searchRequestRef.current;
      setSearchResults(null);
      setSearching(false);
      return;
    }
    const requestId = ++searchRequestRef.current;
    setSearchResults(null);
    setSearching(true);
    const timeout = window.setTimeout(() => {
      void request<string[]>({ type: "files.search", projectId, query: normalized })
        .then((results) => {
          if (requestId === searchRequestRef.current) setSearchResults(results);
        })
        .catch((reason) => {
          if (requestId === searchRequestRef.current) {
            setSearchResults([]);
            setTreeError(errorMessage(reason, "搜索文件失败"));
          }
        })
        .finally(() => {
          if (requestId === searchRequestRef.current) setSearching(false);
        });
    }, 220);
    return () => window.clearTimeout(timeout);
  }, [projectId, query, searchRefresh]);

  const openFile = useCallback(async (path: string) => {
    const requestProject = projectId;
    const requestId = ++previewRequestRef.current;
    setSelectedPath(path);
    setSelected(null);
    setPreviewLoading(true);
    setPreviewError("");
    try {
      const content = await request<ProjectFileContent>({ type: "project.file.read", projectId, path });
      if (projectRef.current === requestProject && requestId === previewRequestRef.current) {
        setSelected(content);
      }
    } catch (reason) {
      if (projectRef.current === requestProject && requestId === previewRequestRef.current) {
        setPreviewError(errorMessage(reason, "文件读取失败"));
      }
    } finally {
      if (projectRef.current === requestProject && requestId === previewRequestRef.current) {
        setPreviewLoading(false);
      }
    }
  }, [projectId]);

  const toggleDirectory = async (path: string) => {
    if (expanded.has(path)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      return;
    }
    setExpanded((current) => new Set(current).add(path));
    if (!(path in children)) {
      const loaded = await loadDirectory(path);
      if (!loaded) {
        setExpanded((current) => {
          const next = new Set(current);
          next.delete(path);
          return next;
        });
      }
    }
  };

  const refreshTree = () => {
    const generation = ++treeGenerationRef.current;
    setChildren({});
    setExpanded(new Set());
    setLoadingDirectories(new Set([""]));
    setTreeError("");
    if (query.trim()) setSearchRefresh((value) => value + 1);
    void loadDirectory("", true, generation);
  };

  const renderDirectory = (directory: string, depth: number): ReactNode => {
    const entries = children[directory];
    if (!entries) return null;
    return entries.map((entry) => {
      const isDirectory = entry.kind === "directory";
      const isExpanded = isDirectory && expanded.has(entry.path);
      const isLoading = isDirectory && loadingDirectories.has(entry.path);
      return (
        <div key={entry.path}>
          <button
            type="button"
            role="treeitem"
            aria-expanded={isDirectory ? isExpanded : undefined}
            className="group flex h-7 w-full min-w-0 items-center gap-1 rounded-sm pr-2 text-left text-xs text-zinc-700 outline-none hover:bg-zinc-100 focus-visible:bg-zinc-100 focus-visible:ring-1 focus-visible:ring-zinc-400 dark:text-zinc-300 dark:hover:bg-zinc-900 dark:focus-visible:bg-zinc-900"
            style={{ paddingLeft: `${6 + depth * 14}px` }}
            title={entry.path}
            onClick={() => isDirectory ? void toggleDirectory(entry.path) : void openFile(entry.path)}
          >
            <span className="flex h-4 w-4 shrink-0 items-center justify-center text-zinc-400">
              {isLoading
                ? <LoaderCircle className="h-3 w-3 animate-spin" />
                : isDirectory
                  ? isExpanded
                    ? <ChevronDown className="h-3.5 w-3.5" />
                    : <ChevronRight className="h-3.5 w-3.5" />
                  : null}
            </span>
            {isDirectory
              ? isExpanded
                ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
                : <Folder className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
              : <FileCode2 className="h-3.5 w-3.5 shrink-0 text-zinc-400" />}
            <span className="truncate">{entry.name}</span>
          </button>
          {isExpanded && (
            <>
              {renderDirectory(entry.path, depth + 1)}
              {!isLoading && children[entry.path]?.length === 0 && (
                <div className="h-7 truncate pr-2 text-xs leading-7 text-zinc-400" style={{ paddingLeft: `${40 + depth * 14}px` }}>
                  空文件夹
                </div>
              )}
            </>
          )}
        </div>
      );
    });
  };

  if (selectedPath) {
    const lineCount = selected?.content.split("\n").length ?? 0;
    const lineNumbers = Array.from({ length: lineCount }, (_, index) => index + 1).join("\n");
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-1 border-b border-zinc-200 px-2 dark:border-zinc-800">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="返回文件树"
            title="返回文件树"
            onClick={() => {
              ++previewRequestRef.current;
              setSelectedPath(null);
              setSelected(null);
              setPreviewLoading(false);
              setPreviewError("");
            }}
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1 truncate font-mono text-xs" title={selectedPath}>{selectedPath}</div>
          {selected && <span className="shrink-0 text-[10px] text-zinc-400">{formatBytes(selected.size)}</span>}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            disabled={previewLoading}
            aria-label="重新加载文件"
            title="重新加载文件"
            onClick={() => void openFile(selectedPath)}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${previewLoading ? "animate-spin" : ""}`} />
          </Button>
        </div>
        {previewLoading ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-zinc-500">
            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />加载文件中…
          </div>
        ) : previewError ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <AlertCircle className="h-5 w-5 text-red-500" />
            <div className="max-w-sm text-xs text-red-600 dark:text-red-400">{previewError}</div>
            <Button type="button" variant="outline" size="sm" onClick={() => void openFile(selectedPath)}>重试</Button>
          </div>
        ) : selected?.content === "" ? (
          <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-zinc-400">空文件</div>
        ) : selected ? (
          <div className="workspace-source min-h-0 flex-1 overflow-auto bg-white dark:bg-zinc-950">
            <div className="flex min-h-full w-max min-w-full items-stretch">
              <pre aria-hidden="true" className="sticky left-0 shrink-0 select-none border-r border-zinc-200 bg-zinc-50 px-3 py-3 text-right font-mono text-xs leading-5 text-zinc-400 dark:border-zinc-800 dark:bg-zinc-900/80 dark:text-zinc-600">{lineNumbers}</pre>
              <pre className="min-w-max flex-1 whitespace-pre px-3 py-3 font-mono text-xs leading-5 text-zinc-800 dark:text-zinc-200">{selected.content}</pre>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  const normalizedQuery = query.trim();
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-zinc-200 p-2 dark:border-zinc-800">
        <div className="flex items-center gap-1">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-400" />
            <Input
              value={query}
              onChange={(event) => { setQuery(event.target.value); setTreeError(""); }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setQuery("");
                  setTreeError("");
                }
              }}
              className="h-7 rounded-md pr-7 pl-7 text-xs"
              placeholder="搜索文件"
              aria-label="搜索文件"
            />
            {query && (
              <button
                type="button"
                className="absolute top-1/2 right-1 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                aria-label="清除搜索"
                title="清除搜索"
                onClick={() => {
                  setQuery("");
                  setTreeError("");
                }}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="全部折叠" title="全部折叠" disabled={expanded.size === 0 || Boolean(normalizedQuery)} onClick={() => setExpanded(new Set())}>
            <ChevronsDownUp className="h-3.5 w-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="刷新文件" title="刷新文件" onClick={refreshTree}>
            <RefreshCw className={`h-3.5 w-3.5 ${loadingDirectories.has("") || searching ? "animate-spin" : ""}`} />
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1.5">
        {treeError && (
          <div className="mb-1 flex items-start gap-2 rounded-md bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="min-w-0 break-words">{treeError}</span>
          </div>
        )}
        {normalizedQuery ? (
          searching && searchResults === null ? (
            <div className="flex h-24 items-center justify-center text-xs text-zinc-400"><LoaderCircle className="mr-2 h-3.5 w-3.5 animate-spin" />正在搜索…</div>
          ) : searchResults?.length ? (
            <div role="list" aria-label="文件搜索结果">
              {searchResults.map((path) => (
                <button key={path} type="button" role="listitem" title={path} className="flex min-h-8 w-full min-w-0 items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-zinc-100 focus-visible:ring-1 focus-visible:ring-zinc-400 dark:hover:bg-zinc-900" onClick={() => void openFile(path)}>
                  <FileCode2 className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
                  <span className="min-w-0 flex-1 truncate font-medium">{baseName(path)}</span>
                  <span className="hidden min-w-0 max-w-[50%] truncate text-[10px] text-zinc-400 sm:block">{parentPath(path) || "."}</span>
                </button>
              ))}
            </div>
          ) : !searching ? (
            <div className="flex h-24 items-center justify-center text-xs text-zinc-400">没有匹配的文件</div>
          ) : null
        ) : loadingDirectories.has("") && !("" in children) ? (
          <div className="flex h-24 items-center justify-center text-xs text-zinc-400"><LoaderCircle className="mr-2 h-3.5 w-3.5 animate-spin" />正在加载文件…</div>
        ) : children[""]?.length ? (
          <div role="tree" aria-label="项目文件">{renderDirectory("", 0)}</div>
        ) : !treeError ? (
          <div className="flex h-24 items-center justify-center text-xs text-zinc-400">项目中暂无文件</div>
        ) : (
          <div className="flex justify-center pt-4"><Button type="button" variant="outline" size="sm" onClick={refreshTree}>重试</Button></div>
        )}
      </div>
    </div>
  );
}
