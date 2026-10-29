import type { ThreadOverviewAnnotations } from "@cca/protocol";

export function validateThreadOverview(value: unknown): ThreadOverviewAnnotations {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("会话概览格式无效");
  const input = value as Record<string, unknown>;
  if (input.goal !== undefined && (typeof input.goal !== "string" || input.goal.length > 4000)) {
    throw new Error("目标最多 4000 字");
  }
  if (!Array.isArray(input.notes) || input.notes.length > 50) throw new Error("关键结论最多 50 条");
  const ids = new Set<string>();
  const notes = input.notes.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("结论格式无效");
    const note = raw as Record<string, unknown>;
    if (typeof note.id !== "string" || !note.id || note.id.length > 128 || ids.has(note.id)) throw new Error("结论标识无效");
    if (typeof note.text !== "string" || !note.text.trim() || note.text.length > 4000) throw new Error("结论须为 1～4000 字");
    if (typeof note.pinned !== "boolean") throw new Error("固定状态无效");
    if (note.sourceTurnId !== undefined && (typeof note.sourceTurnId !== "string" || note.sourceTurnId.length > 256)) {
      throw new Error("结论来源无效");
    }
    ids.add(note.id);
    return { id: note.id, text: note.text.trim(), pinned: note.pinned,
      ...(typeof note.sourceTurnId === "string" ? { sourceTurnId: note.sourceTurnId } : {}) };
  });
  return { ...(typeof input.goal === "string" && input.goal.trim() ? { goal: input.goal.trim() } : {}), notes };
}
