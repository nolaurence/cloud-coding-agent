import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu } from "lucide-react";
import type { ModelRef } from "@cca/protocol";
import { useApp } from "../lib/store";
import { cn } from "../lib/utils";

export function ModelPicker({
  value,
  onChange,
  disabled = false,
  direction = "up",
}: {
  value: ModelRef | undefined;
  onChange: (ref: ModelRef) => void;
  disabled?: boolean;
  direction?: "up" | "down";
}) {
  const models = useApp((s) => s.models);
  const settings = useApp((s) => s.settings);
  const refreshModels = useApp((s) => s.refreshModels);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (models.length === 0) void refreshModels();
  }, [models.length, refreshModels]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const current = value ?? settings?.defaultModel;
  const currentLabel =
    models.find((m) => m.ref.providerId === current?.providerId && m.ref.modelId === current?.modelId)
      ?.label ?? (current ? `${current.providerId} / ${current.modelId}` : "默认模型");

  const filtered = models.filter((m) => m.label.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label="选择模型"
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        title={currentLabel}
        className="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-zinc-300 px-2.5 text-xs hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
        onClick={() => setOpen((v) => !v)}
      >
        <Cpu className="h-3.5 w-3.5 text-zinc-500" />
        <span className="max-w-16 truncate sm:max-w-56">{currentLabel}</span>
        <ChevronDown className="h-3.5 w-3.5 text-zinc-400" />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="模型列表"
          className={cn(
            "absolute left-0 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900",
            direction === "up" ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          <div className="border-b border-zinc-100 p-2 dark:border-zinc-800">
            <input
              autoFocus
              className="w-full rounded-md border border-zinc-200 bg-transparent px-2 py-1.5 text-xs outline-none dark:border-zinc-700"
              placeholder="搜索模型…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
              }}
            />
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <div className="px-2 py-4 text-center text-xs text-zinc-500">
                无可用模型,请先在 设置 → 模型 中配置
              </div>
            )}
            {filtered.map((m) => {
              const selected =
                current?.providerId === m.ref.providerId && current?.modelId === m.ref.modelId;
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  key={`${m.ref.providerId}:${m.ref.modelId}`}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-800",
                    selected && "font-medium",
                  )}
                  onClick={() => {
                    onChange(m.ref);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{m.label}</span>
                  {selected && <Check className="h-3.5 w-3.5 text-blue-500" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
