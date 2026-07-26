import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { DirectoryBrowseEntry, DirectoryBrowseResult } from "@cca/protocol";
import { ArrowDown, ArrowLeft, ArrowUp, CornerLeftUp, Folder, Loader2 } from "lucide-react";
import { useApp } from "../lib/store";
import {
  appendBrowsePath,
  canNavigateUp,
  getBrowseDirectoryPath,
  getBrowseLeaf,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  isBrowseDirectoryPath,
} from "../lib/directoryPaths";
import { cn } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";

interface ProjectDirectoryPickerProps {
  onClose: () => void;
  onAdd: (path: string) => Promise<unknown>;
}

type PickerItem =
  | { kind: "up"; name: ".." }
  | { kind: "directory"; name: string; entry: DirectoryBrowseEntry };

function KeyHint({ children }: { children: ReactNode }) {
  return (
    <Kbd className="min-h-6 min-w-6 px-1.5 text-[11px] leading-none">
      {children}
    </Kbd>
  );
}

export function ProjectDirectoryPicker({ onClose, onAdd }: ProjectDirectoryPickerProps) {
  const browseDirectories = useApp((state) => state.browseDirectories);
  const [query, setQuery] = useState("~/");
  const [listing, setListing] = useState<{
    directoryPath: string;
    result: DirectoryBrowseResult;
  } | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const [submitError, setSubmitError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const trimmedQuery = query.trim();
  const directoryPath = getBrowseDirectoryPath(trimmedQuery);
  const leaf = hasTrailingPathSeparator(trimmedQuery) ? "" : getBrowseLeaf(trimmedQuery);
  const currentListing = listing?.directoryPath === directoryPath ? listing.result : null;

  const filteredEntries = useMemo(() => {
    const lowerLeaf = leaf.toLowerCase();
    const showHidden = leaf.startsWith(".");
    return (currentListing?.entries ?? []).filter(
      (entry) =>
        entry.name.toLowerCase().startsWith(lowerLeaf) &&
        (showHidden || !entry.name.startsWith(".")),
    );
  }, [currentListing, leaf]);

  const canBrowseUp = canNavigateUp(directoryPath);
  const items = useMemo<PickerItem[]>(
    () => [
      ...(canBrowseUp ? ([{ kind: "up", name: ".." }] satisfies PickerItem[]) : []),
      ...filteredEntries.map((entry) => ({ kind: "directory" as const, name: entry.name, entry })),
    ],
    [canBrowseUp, filteredEntries],
  );

  const exactEntry = leaf ? filteredEntries.find((entry) => entry.name === leaf) : undefined;
  const resolvedAddPath =
    trimmedQuery === "~" || hasTrailingPathSeparator(trimmedQuery)
      ? currentListing?.parentPath
      : exactEntry?.fullPath;
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const addShortcut = activeIndex === null ? "Enter" : `${isMac ? "⌘" : "Ctrl"} Enter`;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex(null);
    if (!isBrowseDirectoryPath(directoryPath)) {
      setListing(null);
      setLoading(false);
      setBrowseError("");
      return;
    }

    let cancelled = false;
    setLoading(true);
    setBrowseError("");
    setListing((current) => (current?.directoryPath === directoryPath ? current : null));
    void browseDirectories(directoryPath)
      .then((result) => {
        if (!cancelled) setListing({ directoryPath, result });
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          setListing(null);
          setBrowseError(reason instanceof Error ? reason.message : "无法读取目录");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [browseDirectories, directoryPath]);

  useEffect(() => {
    if (activeIndex !== null && activeIndex >= items.length) setActiveIndex(null);
  }, [activeIndex, items.length]);

  useEffect(() => {
    if (activeIndex === null) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-picker-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const updateQuery = (nextQuery: string) => {
    setQuery(nextQuery);
    setActiveIndex(null);
    setSubmitError("");
  };

  const executeItem = (item: PickerItem) => {
    if (item.kind === "up") {
      const parentPath = getBrowseParentPath(trimmedQuery);
      if (parentPath) updateQuery(parentPath);
    } else {
      updateQuery(appendBrowsePath(trimmedQuery, item.name));
    }
    inputRef.current?.focus();
  };

  const submit = async () => {
    if (!resolvedAddPath || adding || loading) return;
    setAdding(true);
    setSubmitError("");
    try {
      await onAdd(resolvedAddPath);
      onClose();
    } catch (reason) {
      setSubmitError(reason instanceof Error ? reason.message : "添加项目失败");
      setAdding(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Backspace" && query === "") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
      setActiveIndex((current) => {
        if (current === null) return event.key === "ArrowDown" ? 0 : items.length - 1;
        return event.key === "ArrowDown"
          ? (current + 1) % items.length
          : (current - 1 + items.length) % items.length;
      });
      return;
    }
    if (event.key !== "Enter") return;

    event.preventDefault();
    const useModifier = event.ctrlKey || event.metaKey;
    if (activeIndex !== null && !useModifier) {
      const item = items[activeIndex];
      if (item) executeItem(item);
      return;
    }
    void submit();
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(46rem,calc(100vh-2rem))] w-[min(64rem,calc(100vw-2rem))] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(64rem,calc(100vw-2rem))]"
      >
        <DialogTitle className="sr-only">添加项目目录</DialogTitle>
        <div className="flex h-16 shrink-0 items-center gap-2 px-4">
          <Button variant="ghost" size="icon" title="返回" aria-label="返回" onClick={onClose}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <Input
            ref={inputRef}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="project-directory-list"
            aria-activedescendant={activeIndex === null ? undefined : `project-directory-${activeIndex}`}
            className="mono h-10 min-w-0 flex-1 border-0 bg-transparent px-1 text-base font-medium shadow-none focus-visible:ring-0 dark:bg-transparent"
            value={query}
            spellCheck={false}
            placeholder="输入服务器上的绝对路径"
            onChange={(event) => updateQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <Button
            variant="outline"
            className="shrink-0 gap-2 pr-1.5"
            disabled={!resolvedAddPath || loading || adding}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => void submit()}
          >
            {adding ? <Loader2 className="h-4 w-4 animate-spin" /> : "添加"}
            <KeyHint>{addShortcut}</KeyHint>
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col border-y border-zinc-200 dark:border-zinc-800">
          <div className="px-7 pt-5 pb-2 text-xs font-medium text-zinc-500 dark:text-zinc-400">目录</div>
          {(submitError || browseError) && (
            <div role="alert" className="mx-4 mb-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600 dark:bg-red-950/40 dark:text-red-400">
              {submitError || browseError}
            </div>
          )}
          <div
            ref={listRef}
            id="project-directory-list"
            role="listbox"
            aria-label="目录"
            aria-busy={loading}
            className="min-h-0 flex-1 overflow-y-auto px-3 pb-4"
          >
            {loading && !currentListing ? (
              <div className="flex h-32 items-center justify-center gap-2 text-sm text-zinc-500">
                <Loader2 className="h-4 w-4 animate-spin" /> 正在读取目录…
              </div>
            ) : items.length === 0 ? (
              <div className="flex h-32 items-center justify-center text-sm text-zinc-500">
                {isBrowseDirectoryPath(directoryPath) ? "没有匹配的子目录" : "请输入绝对路径"}
              </div>
            ) : (
              items.map((item, index) => (
                <Button
                  key={item.kind === "up" ? "up" : item.entry.fullPath}
                  id={`project-directory-${index}`}
                  type="button"
                  role="option"
                  aria-selected={activeIndex === index}
                  data-picker-index={index}
                  variant="ghost"
                  className={cn(
                    "h-11 w-full justify-start gap-3 px-3 text-left text-sm font-normal",
                    activeIndex === index
                      ? "bg-zinc-100 text-zinc-950 dark:bg-zinc-800 dark:text-white"
                      : "text-zinc-700 hover:bg-zinc-50 dark:text-zinc-300 dark:hover:bg-zinc-800/60",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => executeItem(item)}
                >
                  {item.kind === "up" ? (
                    <CornerLeftUp className="h-5 w-5 shrink-0 text-zinc-500" />
                  ) : (
                    <Folder className="h-5 w-5 shrink-0 text-zinc-500" />
                  )}
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                </Button>
              ))
            )}
          </div>
        </div>

        <div className="flex min-h-14 shrink-0 flex-wrap items-center gap-x-5 gap-y-2 px-5 py-3 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="flex items-center gap-1.5">
            <KeyHint><ArrowUp className="h-3.5 w-3.5" /></KeyHint>
            <KeyHint><ArrowDown className="h-3.5 w-3.5" /></KeyHint>
            导航
          </span>
          <span className="flex items-center gap-1.5"><KeyHint>Enter</KeyHint> 选择</span>
          <span className="flex items-center gap-1.5"><KeyHint>Backspace</KeyHint> 返回</span>
          <span className="flex items-center gap-1.5"><KeyHint>Esc</KeyHint> 关闭</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
