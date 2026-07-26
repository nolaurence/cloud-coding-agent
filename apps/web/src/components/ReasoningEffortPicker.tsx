import { REASONING_EFFORTS } from "@cca/protocol";
import type { ModelRef, ReasoningEffort } from "@cca/protocol";
import { useApp } from "../lib/store";
import { Select } from "./ui/primitives";

const labels: Record<ReasoningEffort, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
};

export function ReasoningEffortPicker({
  model,
  disabled = false,
  onChange,
}: {
  model: ModelRef | undefined;
  disabled?: boolean;
  onChange: (effort: ReasoningEffort | undefined) => void;
}) {
  const models = useApp((s) => s.models);
  const option = models.find(
    (candidate) =>
      candidate.ref.providerId === model?.providerId && candidate.ref.modelId === model?.modelId,
  );
  const supported = option?.supportedReasoningEfforts;
  const unsupported = supported?.length === 0;
  const choices = supported ?? [...REASONING_EFFORTS];
  const selected =
    model?.reasoningEffort && choices.includes(model.reasoningEffort)
      ? model.reasoningEffort
      : undefined;
  const defaultLabel = option?.defaultReasoningEffort
    ? `模型默认 (${labels[option.defaultReasoningEffort]})`
    : "模型默认";

  return (
    <Select
      aria-label="推理强度"
      className="h-8 w-28 shrink-0 text-xs sm:w-32 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled || !model || unsupported}
      value={selected ?? ""}
      onChange={(event) =>
        onChange((event.target.value || undefined) as ReasoningEffort | undefined)
      }
    >
      {!model ? (
        <option value="">请先选择模型</option>
      ) : unsupported ? (
        <option value="">不支持推理</option>
      ) : (
        <>
          <option value="">{defaultLabel}</option>
          {choices.map((effort) => (
            <option key={effort} value={effort}>
              推理强度：{labels[effort]}
            </option>
          ))}
        </>
      )}
    </Select>
  );
}
