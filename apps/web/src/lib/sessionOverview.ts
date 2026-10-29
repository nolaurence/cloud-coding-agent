import type { ChatMessage, SubagentActivity, ToolActivity } from "@cca/protocol";

export interface OverviewStep {
  text: string;
  status: "pending" | "in_progress" | "completed";
  turnId: string;
}

export interface OverviewArtifact {
  path: string;
  turnId: string;
}

export function shortOverviewText(text: string, limit = 180): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/[#*`>]/g, "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parsed(value: string | undefined): Record<string, unknown> {
  try { return record(JSON.parse(value ?? "{}")); } catch { return {}; }
}

function argumentsOf(activity: ToolActivity): Record<string, unknown> {
  const outer = parsed(activity.args);
  const inner = typeof outer.arguments === "string" ? parsed(outer.arguments) : record(outer.arguments);
  return { ...outer, ...inner };
}

export function overviewPlan(messages: readonly ChatMessage[], activities: readonly ToolActivity[]): { steps: OverviewStep[]; origin: "native" | "markdown" | "none" } {
  const updates = activities.filter((activity) => /(?:update_plan|todo_write|todowrite|write_todos)/i.test(activity.toolName) && activity.status !== "error")
    .reverse().sort((left, right) => right.startedAt - left.startedAt);
  for (const update of updates) {
    const args = argumentsOf(update);
    const items = args.plan ?? args.todos;
    if (!Array.isArray(items)) continue;
    const steps = items.flatMap((raw): OverviewStep[] => {
      const item = record(raw);
      const text = item.step ?? item.content ?? item.text;
      if (typeof text !== "string" || !text.trim()) return [];
      const status = item.status === "completed" ? "completed" : item.status === "in_progress" ? "in_progress" : "pending";
      return [{ text: text.trim(), status, turnId: update.turnId }];
    });
    return { steps, origin: "native" };
  }
  for (const message of [...messages].reverse()) {
    if (message.role !== "assistant" || message.streaming) continue;
    const steps = message.text.replace(/```[\s\S]*?```/g, "").split("\n").flatMap((line): OverviewStep[] => {
      const match = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/.exec(line);
      return match ? [{ text: match[2]!, status: match[1]!.toLowerCase() === "x" ? "completed" : "pending", turnId: message.turnId }] : [];
    });
    if (steps.length) return { steps, origin: "markdown" };
  }
  return { steps: [], origin: "none" };
}

export function overviewArtifacts(activities: readonly ToolActivity[]): OverviewArtifact[] {
  const files = new Map<string, OverviewArtifact>();
  for (const activity of activities) {
    if (activity.status !== "complete" || !/(?:edit|write|create|patch|replace|insert|delete|rename|move)/i.test(activity.toolName)
      || /(?:todo|plan)/i.test(activity.toolName)) continue;
    const args = argumentsOf(activity);
    const paths: string[] = [];
    for (const key of ["path", "filePath", "file_path", "filename", "file"]) {
      if (typeof args[key] === "string") paths.push(args[key] as string);
    }
    if (Array.isArray(args.changes)) {
      for (const change of args.changes) {
        const file = record(change).path;
        if (typeof file === "string") paths.push(file);
      }
    }
    const patch = [args.patch, args.input, args.command, args.cmd].filter((value): value is string => typeof value === "string").join("\n");
    for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) paths.push(match[1]!);
    for (const file of paths) {
      const cleaned = file.trim();
      if (cleaned && cleaned.length < 1000 && !cleaned.includes("\n")) files.set(cleaned, { path: cleaned, turnId: activity.turnId });
    }
  }
  return [...files.values()];
}

export function overviewChecks(activities: readonly ToolActivity[]): ToolActivity[] {
  return activities.filter((activity) => {
    if (!/(?:bash|shell|exec|command|terminal)/i.test(activity.toolName)) return false;
    const args = argumentsOf(activity);
    const command = args.command ?? args.cmd;
    return typeof command === "string" && /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test[\w:-]*|typecheck|lint|build)|\b(?:pytest|vitest|jest)\b|\b(?:go|cargo)\s+(?:test|check|build)|\btsc\b|\bnode\b[^\n]*\s--test\b)/i.test(command);
  });
}

export function overviewCommand(activity: ToolActivity): string {
  const args = argumentsOf(activity);
  return String(args.command ?? args.cmd ?? activity.toolName);
}

export function currentOverviewStep(steps: readonly OverviewStep[], activities: readonly ToolActivity[], subagents: readonly SubagentActivity[], running: boolean): string {
  if (!running) return "当前没有运行中的任务";
  const active = [...activities].reverse().find((activity) => activity.status === "running" && !/(?:update_plan|todo_write)/i.test(activity.toolName));
  if (active) {
    const args = argumentsOf(active);
    const target = args.command ?? args.cmd ?? args.path ?? args.file_path ?? "";
    return shortOverviewText(`${active.toolName}${target ? ` · ${String(target)}` : ""}`, 120);
  }
  const child = subagents.find((subagent) => subagent.status === "running");
  return child ? `子代理 · ${child.agentDisplayName || child.agentName}` : steps.find((step) => step.status === "in_progress")?.text ?? "正在分析与执行";
}
