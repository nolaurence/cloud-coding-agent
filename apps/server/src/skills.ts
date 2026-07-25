import fs from "node:fs";
import path from "node:path";
import { SkillInfo } from "@cca/protocol";
import { SKILLS_DIR } from "./env.js";
import { store } from "./store.js";

function parseFrontmatter(raw: string): { name?: string; description?: string; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { body: raw };
  const fm = match[1] ?? "";
  const body = match[2] ?? "";
  const name = fm.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = fm.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description, body };
}

export function listSkills(): SkillInfo[] {
  const settings = store.settings;
  const dirs = [SKILLS_DIR, ...settings.skillDirectories];
  const seen = new Set<string>();
  const skills: SkillInfo[] = [];

  for (const dir of dirs) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(dir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      let raw = "";
      try {
        raw = fs.readFileSync(skillFile, "utf8");
      } catch {
        continue;
      }
      const { name, description, body } = parseFrontmatter(raw);
      const skillName = name || entry.name;
      if (seen.has(skillName)) continue;
      seen.add(skillName);
      skills.push({
        name: skillName,
        description: description ?? "",
        directory: path.join(dir, entry.name),
        content: raw,
        disabled: settings.disabledSkills.includes(skillName),
        builtin: path.join(dir, entry.name).startsWith(SKILLS_DIR),
      });
    }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

export function saveSkill(name: string, description: string, content: string) {
  const safe = name.replace(/[^\w.-]+/g, "-").toLowerCase();
  const dir = path.join(SKILLS_DIR, safe);
  fs.mkdirSync(dir, { recursive: true });
  const body = content.includes("---")
    ? content
    : `---\nname: ${safe}\ndescription: ${description}\n---\n\n${content}`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), body, "utf8");
}

export function deleteSkill(name: string) {
  const dir = path.join(SKILLS_DIR, name);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

export function enabledSkillDirectories(): { dirs: string[]; disabled: string[] } {
  const settings = store.settings;
  const hasAny = listSkills().length > 0;
  return {
    dirs: hasAny ? [SKILLS_DIR, ...settings.skillDirectories] : [],
    disabled: settings.disabledSkills,
  };
}
