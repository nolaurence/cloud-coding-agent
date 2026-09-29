import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Project } from "@cca/protocol";
import { WORKSPACE_ROOT } from "./env.js";
import { store } from "./store.js";

const MAX_WORKSPACE_NAME_LENGTH = 80;

export function normalizeWorkspaceName(input: string): string {
  const name = input.trim();
  if (!name) throw new Error("请输入工作区名称");
  if (Array.from(name).length > MAX_WORKSPACE_NAME_LENGTH) {
    throw new Error(`工作区名称不能超过 ${MAX_WORKSPACE_NAME_LENGTH} 个字符`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(name)) {
    throw new Error("工作区名称不能包含控制字符");
  }
  return name;
}

export async function createUserWorkspace(
  ownerId: string,
  inputName: string,
  workspaceRoot = WORKSPACE_ROOT,
): Promise<Project> {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId) throw new Error("工作区所有者无效");
  const name = normalizeWorkspaceName(inputName);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const root = fs.realpathSync(workspaceRoot);
  const id = randomUUID();
  const projectPath = path.join(root, id);
  fs.mkdirSync(projectPath, { mode: 0o700 });

  const project: Project = {
    id,
    name,
    path: fs.realpathSync(projectPath),
    ownerId: normalizedOwnerId,
  };
  try {
    await store.addProject(project);
    return project;
  } catch (error) {
    fs.rmSync(projectPath, { recursive: true, force: true });
    throw error;
  }
}

/** Register an existing directory selected by the desktop user. */
export async function registerSelectedWorkspace(
  ownerId: string,
  inputName: string,
  selectedPath: string,
): Promise<Project> {
  const normalizedOwnerId = ownerId.trim();
  if (!normalizedOwnerId) throw new Error("工作区所有者无效");
  const name = normalizeWorkspaceName(inputName);
  if (!selectedPath || selectedPath.includes("\0")) throw new Error("本地文件夹路径无效");
  const projectPath = fs.realpathSync(selectedPath);
  if (!fs.statSync(projectPath).isDirectory()) throw new Error("本地文件夹无效");

  const project: Project = {
    id: randomUUID(),
    name,
    path: projectPath,
    ownerId: normalizedOwnerId,
  };
  await store.addProject(project);
  return project;
}
