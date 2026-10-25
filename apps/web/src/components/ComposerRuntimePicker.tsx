import { useState } from "react";
import { Check, ChevronDown, Cpu, Sparkles } from "lucide-react";
import { Popover } from "radix-ui";
import type { AgentRuntime } from "@cca/protocol";
import "./composer.css";

const options: Array<{
  runtime: AgentRuntime;
  label: string;
  shortLabel: string;
  description: string;
  icon: typeof Cpu;
}> = [
  {
    runtime: "codex",
    label: "Codex",
    shortLabel: "Codex",
    description: "OpenAI Codex app-server，沿用现有模型、工具与登录方式",
    icon: Cpu,
  },
  {
    runtime: "dsh",
    label: "DeepSeek Harness",
    shortLabel: "DSH",
    description: "DeepSeek Harness 运行时，需要已配置的自定义模型服务",
    icon: Sparkles,
  },
];

export function ComposerRuntimePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: AgentRuntime;
  onChange: (runtime: AgentRuntime) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.runtime === value) ?? options[0]!;
  const TriggerIcon = current.icon;

  return (
    <Popover.Root open={open} onOpenChange={(next) => setOpen(next && !disabled)}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="composer-model-trigger"
          aria-label="选择执行引擎"
          title={`执行引擎：${current.label}`}
          disabled={disabled}
        >
          <TriggerIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="composer-model-name">{current.shortLabel}</span>
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
          aria-label="执行引擎"
        >
          <div className="px-2 pb-1.5 pt-1 text-[13px] font-medium">
            使用哪个执行引擎？
          </div>
          {options.map((option) => {
            const selected = option.runtime === value;
            const Icon = option.icon;
            return (
              <button
                key={option.runtime}
                type="button"
                aria-pressed={selected}
                disabled={disabled}
                onClick={() => {
                  setOpen(false);
                  onChange(option.runtime);
                }}
                className="flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium leading-5">{option.label}</span>
                  <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
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
