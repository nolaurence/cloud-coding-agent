import type { Workspace } from "@cca/protocol";

export type WorkspaceDropPlacement = "before" | "after";

const WORKSPACE_ORDER_KEY = "cloud-coding-agent:workspace-order:";

export function loadWorkspaceOrder(username: string): string[] {
  try {
    const value: unknown = JSON.parse(
      localStorage.getItem(WORKSPACE_ORDER_KEY + encodeURIComponent(username)) ?? "[]",
    );
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))]
      : [];
  } catch {
    return [];
  }
}

export function saveWorkspaceOrder(username: string, order: readonly string[]): void {
  try {
    localStorage.setItem(
      WORKSPACE_ORDER_KEY + encodeURIComponent(username),
      JSON.stringify(order),
    );
  } catch {
    return;
  }
}

export function sortSidebarWorkspaces(
  workspaces: readonly Workspace[],
  order: readonly string[],
): Workspace[] {
  const remaining = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const sorted: Workspace[] = [];
  for (const id of order) {
    const workspace = remaining.get(id);
    if (!workspace) continue;
    sorted.push(workspace);
    remaining.delete(id);
  }
  return [...sorted, ...remaining.values()];
}

export function moveSidebarWorkspace(
  workspaces: Workspace[],
  sourceId: string,
  targetId: string,
  placement: WorkspaceDropPlacement,
): Workspace[] {
  const source = workspaces.find((workspace) => workspace.id === sourceId);
  if (!source || sourceId === targetId) return workspaces;
  const next = workspaces.filter((workspace) => workspace.id !== sourceId);
  const targetIndex = next.findIndex((workspace) => workspace.id === targetId);
  if (targetIndex < 0) return workspaces;
  next.splice(targetIndex + (placement === "after" ? 1 : 0), 0, source);
  return next.every((workspace, index) => workspace === workspaces[index]) ? workspaces : next;
}
