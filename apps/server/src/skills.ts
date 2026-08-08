import fs from "node:fs";
import path from "node:path";
import type { ResourceScope, SkillInfo } from "@cca/protocol";
import { SKILLS_DIR } from "./env.js";
import { store } from "./store.js";

const WORKSPACE_SKILLS_PATH = path.join(".github", "skills");
const SKILL_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { body: raw };
  const fm = match[1] ?? "";
  return {
    name: fm.match(/^name:\s*(.+)$/m)?.[1]?.trim(),
    description: fm.match(/^description:\s*(.*)$/m)?.[1]?.trim(),
    body: match[2] ?? "",
  };
}

export function normalizeSkillName(input: string): string {
  const name = input.trim().toLowerCase();
  if (!SKILL_NAME.test(name)) {
    throw new Error("技能名称只能包含小写字母、数字和中划线，长度不超过 64 个字符");
  }
  return name;
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function nearestExistingPath(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function workspaceSkillsDir(workspacePath: string): string {
  const root = fs.realpathSync(workspacePath);
  const target = path.join(root, WORKSPACE_SKILLS_PATH);
  const existing = fs.realpathSync(nearestExistingPath(target));
  if (!isInside(root, existing)) throw new Error("工作区技能目录不能通过符号链接指向工作区外");
  return target;
}

function scopeDirectories(scope: ResourceScope, workspacePath?: string): string[] {
  if (scope === "workspace") {
    if (!workspacePath) throw new Error("工作区技能操作缺少工作区路径");
    return [workspaceSkillsDir(workspacePath)];
  }
  return [SKILLS_DIR, ...store.settings.skillDirectories];
}

function scanSkills(scope: ResourceScope, workspacePath?: string): SkillInfo[] {
  const dirs = scopeDirectories(scope, workspacePath);
  const seen = new Set<string>();
  const skills: SkillInfo[] = [];

  for (const dir of dirs) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(dir, entry.name, "SKILL.md");
      if (scope === "workspace" && fs.existsSync(skillFile)) {
        const root = fs.realpathSync(dir);
        if (!isInside(root, fs.realpathSync(skillFile))) {
          throw new Error("工作区技能文件不能通过符号链接指向技能目录外");
        }
      }
      let raw: string;
      try {
        raw = fs.readFileSync(skillFile, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const parsed = parseFrontmatter(raw);
      const skillName = parsed.name || entry.name;
      if (seen.has(skillName)) continue;
      seen.add(skillName);
      skills.push({
        name: skillName,
        description: parsed.description ?? "",
        directory: path.join(dir, entry.name),
        content: raw,
        disabled: scope === "platform" && store.settings.disabledSkills.includes(skillName),
        builtin: scope === "platform" && path.resolve(dir) === path.resolve(SKILLS_DIR),
        scope,
      });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function listSkills(): SkillInfo[] {
  return scanSkills("platform");
}

export function listScopedSkills(scope: ResourceScope, workspacePath?: string): SkillInfo[] {
  return scanSkills(scope, workspacePath);
}

export function getScopedSkill(
  scope: ResourceScope,
  name: string,
  workspacePath?: string,
): SkillInfo | undefined {
  const normalized = normalizeSkillName(name);
  return scanSkills(scope, workspacePath).find((skill) => skill.name === normalized);
}

function managedSkillDir(scope: ResourceScope, name: string, workspacePath?: string): string {
  const base = scope === "platform"
    ? SKILLS_DIR
    : workspacePath
      ? workspaceSkillsDir(workspacePath)
      : (() => { throw new Error("工作区技能操作缺少工作区路径"); })();
  return path.join(base, normalizeSkillName(name));
}

export function saveScopedSkill(
  scope: ResourceScope,
  name: string,
  description: string,
  content: string,
  workspacePath?: string,
  mode: "upsert" | "create" | "update" = "upsert",
): SkillInfo {
  const normalized = normalizeSkillName(name);
  const existing = getScopedSkill(scope, normalized, workspacePath);
  if (mode === "create" && existing) throw new Error("技能已存在");
  if (mode === "update" && !existing) throw new Error("技能不存在");
  if (existing && scope === "platform" && !existing.builtin) {
    throw new Error("额外目录中的技能为只读，请修改其源目录");
  }

  const dir = managedSkillDir(scope, normalized, workspacePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const body = parseFrontmatter(content).body;
  const cleanDescription = description.trim().replace(/\s+/g, " ");
  const raw = `---\nname: ${normalized}\ndescription: ${cleanDescription}\n---\n\n${body}`;
  const file = path.join(dir, "SKILL.md");
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, raw, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
  const saved = getScopedSkill(scope, normalized, workspacePath);
  if (!saved) throw new Error("技能保存后无法读取");
  return saved;
}

export function saveSkill(name: string, description: string, content: string): SkillInfo {
  return saveScopedSkill("platform", name, description, content);
}

export function deleteScopedSkill(
  scope: ResourceScope,
  name: string,
  workspacePath?: string,
): void {
  const normalized = normalizeSkillName(name);
  const existing = getScopedSkill(scope, normalized, workspacePath);
  if (!existing) throw new Error("技能不存在");
  if (scope === "platform" && !existing.builtin) {
    throw new Error("额外目录中的技能为只读，请修改其源目录");
  }
  fs.rmSync(managedSkillDir(scope, normalized, workspacePath), { recursive: true, force: false });
}

export function deleteSkill(name: string): void {
  deleteScopedSkill("platform", name);
}

export function enabledSkillDirectories(workspacePath: string): { dirs: string[]; disabled: string[] } {
  const workspaceDir = workspaceSkillsDir(workspacePath);
  const platformDirs = [SKILLS_DIR, ...store.settings.skillDirectories];
  const dirs = [workspaceDir, ...platformDirs].filter((dir) => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true }).some((entry) =>
        entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "SKILL.md"))
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  });
  return { dirs, disabled: store.settings.disabledSkills };
}
