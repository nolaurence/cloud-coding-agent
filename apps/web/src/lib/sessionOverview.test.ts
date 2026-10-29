import assert from "node:assert/strict";
import test from "node:test";
import type { ChatMessage, ToolActivity } from "@cca/protocol";
import { currentOverviewStep, overviewArtifacts, overviewChecks, overviewPlan } from "./sessionOverview.js";

function activity(overrides: Partial<ToolActivity> = {}): ToolActivity {
  return { id: "tool-1", turnId: "turn-1", toolName: "update_plan", startedAt: 1, status: "complete", ...overrides };
}
function message(text: string): ChatMessage {
  return { id: "message-1", turnId: "turn-1", role: "assistant", text, createdAt: 1 };
}

test("overview uses the latest native plan and respects an explicitly cleared plan", () => {
  const first = activity({ args: JSON.stringify({ plan: [{ step: "旧计划", status: "completed" }] }) });
  const second = activity({ id: "tool-2", startedAt: 2, args: JSON.stringify({ todos: [{ content: "新任务", status: "in_progress" }] }), toolName: "todo_write" });
  assert.deepEqual(overviewPlan([], [first, second]), { origin: "native", steps: [{ text: "新任务", status: "in_progress", turnId: "turn-1" }] });
  const cleared = activity({ startedAt: 3, args: '{"plan":[]}' });
  assert.deepEqual(overviewPlan([], [first, cleared]), { origin: "native", steps: [] });
  assert.deepEqual(overviewPlan([], [first, { ...cleared, startedAt: first.startedAt }]), { origin: "native", steps: [] });
});

test("overview supports nested Codex arguments and ignores failed updates", () => {
  const native = activity({ args: JSON.stringify({ arguments: { plan: [{ step: "确认", status: "completed" }] } }) });
  const failed = activity({ status: "error", startedAt: 2, args: '{"plan":[]}' });
  assert.equal(overviewPlan([], [native, failed]).steps[0]?.text, "确认");
  assert.equal(overviewPlan([], [activity({ args: "broken json" })]).origin, "none");
});

test("markdown fallback only extracts actual checklists outside code fences", () => {
  const source = message("```md\n- [x] 示例\n```\n- [x] 已验证\n- [ ] 待验收");
  const plan = overviewPlan([source], []);
  assert.equal(plan.origin, "markdown");
  assert.deepEqual(plan.steps.map((step) => step.text), ["已验证", "待验收"]);
  assert.equal(overviewPlan([{ ...source, streaming: true }], []).origin, "none");
});

test("artifacts include successful edits and patches, not reads or failed writes", () => {
  const tools = [activity({ toolName: "apply_patch", args: JSON.stringify({ changes: [{ path: "src/a.ts" }] }) }),
    activity({ toolName: "edit_file", args: '{"file_path":"src/b.ts"}' }),
    activity({ toolName: "apply_patch", args: JSON.stringify({ input: "*** Begin Patch\n*** Add File: doc.md\n+hi\n*** End Patch" }) }),
    activity({ toolName: "read_file", args: '{"path":"secret.txt"}' }),
    activity({ toolName: "write_file", status: "error", args: '{"path":"failed.ts"}' }),
    activity({ toolName: "todo_write", args: '{"path":"fake.ts"}' })];
  assert.deepEqual(overviewArtifacts(tools).map((entry) => entry.path), ["src/a.ts", "src/b.ts", "doc.md"]);
});

test("verification is derived from execution records, not assistant claims", () => {
  const tools = [activity({ toolName: "bash", args: '{"command":"npm run typecheck"}' }),
    activity({ toolName: "exec_command", args: '{"cmd":"node --import tsx --test src/example.test.ts"}', status: "error" }),
    activity({ toolName: "read_file", args: '{"path":"test.ts"}' }),
    activity({ toolName: "bash", args: '{"command":"echo tests passed"}' })];
  assert.equal(overviewChecks(tools).length, 2);
  assert.equal(overviewChecks(tools)[1]?.status, "error");
});

test("current step does not leave a completed tool or stale plan spinning", () => {
  assert.equal(currentOverviewStep([{ text: "计划步骤", status: "in_progress", turnId: "t" }], [], [], false), "当前没有运行中的任务");
  assert.match(currentOverviewStep([], [activity({ status: "running", toolName: "exec_command", args: '{"cmd":"npm test"}' })], [], true), /npm test/);
});
