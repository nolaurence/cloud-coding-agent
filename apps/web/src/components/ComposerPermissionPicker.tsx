import { useState } from "react";
import { AlertCircle, Check, ChevronDown, Hand, ShieldCheck } from "lucide-react";
import { Popover } from "radix-ui";
import type { PermissionMode } from "@cca/protocol";
import { cn } from "../lib/utils";
import "./composer.css";

const options: Array<{
  mode: PermissionMode;
  label: string;
  description: string;
  icon: typeof Hand;
}> = [
  {
    mode: "request",
    label: "请求批准",
    description: "编辑外部文件和使用互联网时始终询问",
    icon: Hand,
  },
  {
    mode: "auto",
    label: "帮我批准",
    description: "仅对检测到的风险操作请求批准",
    icon: ShieldCheck,
  },
  {
    mode: "full",
    label: "完全访问权限",
    description: "不受限制地访问互联网和电脑上的任何文件",
    icon: AlertCircle,
  },
];

export function ComposerPermissionPicker({
  value,
  onChange,
  disabled = false,
  updating = false,
}: {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void | Promise<void>;
  disabled?: boolean;
  updating?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const controlsDisabled = disabled || updating;
  const current = options.find((option) => option.mode === value) ?? options[2]!;
  const TriggerIcon = current.icon;

  return (
    <Popover.Root open={open} onOpenChange={(next) => setOpen(next && !controlsDisabled)}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "composer-model-trigger max-w-[190px]",
            current.mode === "full" && "text-orange-600 dark:text-orange-400",
          )}
          aria-label="选择权限模式"
          title={`权限模式：${current.label}`}
          disabled={controlsDisabled}
        >
          <TriggerIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="composer-model-name">{current.label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="composer-popover w-[360px] max-w-[calc(100vw-24px)] p-2"
          side="top"
          align="end"
          sideOffset={12}
          collisionPadding={12}
          aria-label="权限模式"
        >
          <div className="px-2 pb-1.5 pt-1 text-[13px] font-medium">
            应如何批准 Codex 操作？
          </div>
          {options.map((option) => {
            const selected = option.mode === value;
            const Icon = option.icon;
            const full = option.mode === "full";
            return (
              <button
                key={option.mode}
                type="button"
                aria-pressed={selected}
                disabled={controlsDisabled}
                onClick={() => {
                  setOpen(false);
                  void onChange(option.mode);
                }}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
                  selected && full && "text-orange-600 dark:text-orange-400",
                )}
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    selected && full ? undefined : "text-muted-foreground",
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium leading-5">
                    {option.label}
                  </span>
                  <span
                    className={cn(
                      "mt-0.5 block text-[11px] leading-4",
                      selected && full
                        ? "text-orange-600/80 dark:text-orange-400/80"
                        : "text-muted-foreground",
                    )}
                  >
                    {option.description}
                  </span>
                </span>
                {selected && <Check className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
              </button>
            );
          })}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
