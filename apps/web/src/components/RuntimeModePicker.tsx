import { Check, ChevronDown, Hand, ShieldCheck, Unlock } from "lucide-react";
import type { RuntimeMode } from "@cca/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "../lib/utils";

const options: Array<{
  value: RuntimeMode;
  label: string;
  description: string;
  icon: typeof Hand;
}> = [
  {
    value: "approval-required",
    label: "请求批准",
    description: "受限操作前始终询问",
    icon: Hand,
  },
  {
    value: "auto",
    label: "帮我批准",
    description: "仅对检测到的风险操作请求批准",
    icon: ShieldCheck,
  },
  {
    value: "full-access",
    label: "完全访问",
    description: "允许执行命令和修改文件",
    icon: Unlock,
  },
];

export function RuntimeModePicker({
  value,
  onChange,
  disabled = false,
  direction = "up",
}: {
  value: RuntimeMode;
  onChange: (value: RuntimeMode) => void | Promise<void>;
  disabled?: boolean;
  direction?: "up" | "down";
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const selected = options.find((option) => option.value === value) ?? options[1]!;
  const Icon = selected.icon;

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div className="relative shrink-0" ref={rootRef}>
      <button
        type="button"
        aria-label="选择权限模式"
        aria-controls={open ? menuId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        title={selected.description}
        className="flex h-8 items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 text-xs text-zinc-600 transition-colors hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
        onClick={() => setOpen((current) => !current)}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="max-w-24 truncate">{selected.label}</span>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="权限模式"
          className={cn(
            "absolute left-0 z-50 w-64 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-lg dark:border-zinc-700 dark:bg-zinc-900",
            direction === "up" ? "bottom-full mb-2" : "top-full mt-2",
          )}
        >
          {options.map((option) => {
            const OptionIcon = option.icon;
            const checked = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={checked}
                className={cn(
                  "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-zinc-800",
                  checked && "bg-zinc-100 dark:bg-zinc-800",
                )}
                onClick={() => {
                  setOpen(false);
                  void onChange(option.value);
                }}
              >
                <OptionIcon className="mt-0.5 h-4 w-4 shrink-0 text-zinc-500" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">{option.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-zinc-500 dark:text-zinc-400">
                    {option.description}
                  </span>
                </span>
                {checked && <Check className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
