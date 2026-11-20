import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPOSER_MODEL_MOTION,
  REASONING_THUMB_SIZE_PX,
  modelSectionHeading,
  pickerTriggerCopy,
  prefersReducedMotion,
  reasoningFillWidthPx,
  reasoningSliderProgress,
  rectToTransform,
} from "./composerModelPicker.js";

test("motion timings stay in the 200–350ms range", () => {
  for (const duration of [
    COMPOSER_MODEL_MOTION.openMs,
    COMPOSER_MODEL_MOTION.closeMs,
    COMPOSER_MODEL_MOTION.viewMs,
  ]) {
    assert.ok(duration >= 200 && duration <= 350);
  }
  assert.match(COMPOSER_MODEL_MOTION.openEasing, /cubic-bezier/);
  assert.notEqual(COMPOSER_MODEL_MOTION.openEasing, "linear");
});

test("rectToTransform maps the popover box onto the trigger for a shared-element morph", () => {
  const layout = { left: 40, top: 80, width: 280, height: 140 };
  const trigger = { left: 200, top: 190, width: 112, height: 30 };

  assert.equal(rectToTransform(layout, layout), "translate(0px, 0px) scale(1, 1)");
  assert.equal(
    rectToTransform(layout, trigger),
    `translate(${trigger.left - layout.left}px, ${trigger.top - layout.top}px) scale(${trigger.width / layout.width}, ${trigger.height / layout.height})`,
  );
});

test("closing uses the reverse mapping so the panel shrinks back into the pill", () => {
  const panel = { left: 40, top: 80, width: 280, height: 140 };
  const pill = { left: 200, top: 190, width: 112, height: 30 };
  const openEnd = rectToTransform(panel, panel);
  const closeEnd = rectToTransform(panel, pill);
  assert.equal(openEnd, "translate(0px, 0px) scale(1, 1)");
  assert.notEqual(closeEnd, openEnd);
  assert.match(closeEnd, /^translate\(160px, 110px\) scale\(/);
});

test("picker trigger shows the reasoning prompt only while the intensity panel is open", () => {
  assert.deepEqual(
    pickerTriggerCopy({ open: false, showModels: false, modelLabel: "6 Luna", effortLabel: "极高" }),
    { name: "6 Luna", effort: "极高", muted: false },
  );
  assert.deepEqual(
    pickerTriggerCopy({ open: true, showModels: false, modelLabel: "6 Luna", effortLabel: "极高" }),
    { name: "选择推理强度", effort: null, muted: true },
  );
  assert.deepEqual(
    pickerTriggerCopy({ open: true, showModels: true, modelLabel: "6.1 Sol", effortLabel: "极高" }),
    { name: "6.1 Sol", effort: "极高", muted: false },
  );
});

test("default model group uses the two-line section heading without treating it as a selected row", () => {
  assert.deepEqual(modelSectionHeading("DeepSeek", true), {
    title: "默认",
    subtitle: "推荐模型集",
  });
  assert.deepEqual(modelSectionHeading("OpenAI", false), {
    title: "OpenAI",
    subtitle: null,
  });
});

test("prefersReducedMotion follows the media query when present", () => {
  assert.equal(prefersReducedMotion(undefined), false);
  assert.equal(prefersReducedMotion(() => ({ matches: true })), true);
  assert.equal(prefersReducedMotion(() => ({ matches: false })), false);
});

test("reasoning fill meets the thumb center at every stop, including the ends", () => {
  const trackWidth = 248;
  const thumb = REASONING_THUMB_SIZE_PX;
  const max = 5;
  const thumbCenter = (index: number) =>
    thumb / 2 + (index / max) * (trackWidth - thumb);

  for (const index of [0, 1, 2, 3, 4, 5]) {
    const fill = reasoningFillWidthPx(reasoningSliderProgress(index, max), trackWidth);
    assert.equal(fill, thumbCenter(index));
  }

  assert.equal(reasoningFillWidthPx(0, trackWidth), thumb / 2);
  assert.equal(reasoningFillWidthPx(1, trackWidth), trackWidth - thumb / 2);
});

test("reasoning fill is longer than a raw step-percentage bar so it covers the thumb inset", () => {
  const trackWidth = 248;
  const max = 5;
  const index = 1;
  const rawRange = (index / max) * trackWidth;
  const fill = reasoningFillWidthPx(reasoningSliderProgress(index, max), trackWidth);
  assert.equal(rawRange, 49.6);
  assert.equal(fill, 58);
  assert.ok(fill > rawRange);
});

test("reasoning slider progress clamps to 0–1", () => {
  assert.equal(reasoningSliderProgress(0, 0), 0);
  assert.equal(reasoningSliderProgress(-1, 5), 0);
  assert.equal(reasoningSliderProgress(8, 5), 1);
  assert.equal(reasoningSliderProgress(2, 4), 0.5);
});
