import { useState } from "react";
import { Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { useApp } from "../../lib/store";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormDialog } from "@/components/ui/form-dialog";
import { Input } from "@/components/ui/input";
import { LabeledField } from "@/components/ui/labeled-field";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

export function SkillsSettings() {
  const skills = useApp((s) => s.skills);
  const settings = useApp((s) => s.settings);
  const updateSettings = useApp((s) => s.updateSettings);
  const saveSkill = useApp((s) => s.saveSkill);
  const deleteSkill = useApp((s) => s.deleteSkill);

  const [editing, setEditing] = useState<{ name: string; description: string; content: string } | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [newDir, setNewDir] = useState("");
  const [deletingSkill, setDeletingSkill] = useState<string | null>(null);

  if (!settings) return null;

  const toggle = (name: string, disabled: boolean) => {
    const disabledSkills = disabled
      ? [...settings.disabledSkills, name]
      : settings.disabledSkills.filter((n) => n !== name);
    void updateSettings({ ...settings, disabledSkills });
  };

  const addDirectory = () => {
    const dir = newDir.trim();
    if (!dir) return;
    if (!settings.skillDirectories.includes(dir)) {
      void updateSettings({ ...settings, skillDirectories: [...settings.skillDirectories, dir] });
    }
    setNewDir("");
  };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">技能 (Skills)</h2>
          <p className="text-xs text-zinc-500">
            可复用的提示词模块,在会话中通过输入框的 <span className="mono">/技能名</span> 调用
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => {
            setIsNew(true);
            setEditing({ name: "", description: "", content: "" });
          }}
        >
          <Plus className="h-3.5 w-3.5" /> 新建
        </Button>
      </div>

      <div className="mb-6 flex flex-col gap-3">
        {skills.length === 0 && (
          <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center text-sm text-zinc-500 dark:border-zinc-700">
            还没有技能
          </div>
        )}
        {skills.map((sk) => (
          <div key={sk.name} className="rounded-lg border border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div className="flex items-center gap-3">
              <Sparkles className="h-4 w-4 shrink-0 text-purple-400" />
              <div className="min-w-0 flex-1">
                <div className="mono text-sm font-medium">/{sk.name}</div>
                {sk.description && <div className="truncate text-xs text-zinc-500">{sk.description}</div>}
              </div>
              <Switch
                checked={!sk.disabled}
                aria-label={`${sk.disabled ? "启用" : "停用"}技能 ${sk.name}`}
                onCheckedChange={(enabled) => toggle(sk.name, !enabled)}
              />
              <Button
                variant="ghost"
                size="icon"
                onClick={() => {
                  setIsNew(false);
                  setEditing({ name: sk.name, description: sk.description, content: sk.content });
                }}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              {sk.builtin && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`删除技能 ${sk.name}`}
                  onClick={() => setDeletingSkill(sk.name)}
                >
                  <Trash2 className="h-3.5 w-3.5 text-red-500" />
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      <section>
        <h3 className="mb-2 text-sm font-semibold">额外技能目录</h3>
        <p className="mb-2 text-xs text-zinc-500">服务器上的目录,扫描其下一级子目录中的 SKILL.md</p>
        <div className="flex flex-col gap-2">
          {settings.skillDirectories.map((dir) => (
            <div key={dir} className="flex items-center gap-2 rounded-md border border-zinc-200 px-3 py-2 dark:border-zinc-800">
              <span className="mono min-w-0 flex-1 truncate text-xs">{dir}</span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() =>
                  void updateSettings({
                    ...settings,
                    skillDirectories: settings.skillDirectories.filter((d) => d !== dir),
                  })
                }
              >
                <Trash2 className="h-3.5 w-3.5 text-red-500" />
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            <Input value={newDir} onChange={(e) => setNewDir(e.target.value)} placeholder="/path/to/skills" />
            <Button variant="outline" onClick={addDirectory}>
              添加
            </Button>
          </div>
        </div>
      </section>

      <FormDialog open={editing !== null} onClose={() => setEditing(null)} title={isNew ? "新建技能" : `编辑技能 /${editing?.name}`} wide>
        {editing && (
          <>
            <LabeledField label="名称(小写字母、数字、中划线)">
              <Input
                className="mono"
                value={editing.name}
                disabled={!isNew}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="code-review"
              />
            </LabeledField>
            <LabeledField label="描述">
              <Input value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="这个技能做什么" />
            </LabeledField>
            <LabeledField label="内容(Markdown,将注入到 Agent 上下文)">
              <Textarea
                rows={14}
                className="mono"
                value={editing.content}
                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
                placeholder={"# 指南\n\n1. ...\n2. ..."}
              />
            </LabeledField>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditing(null)}>
                取消
              </Button>
              <Button
                onClick={() => {
                  if (!editing.name.trim()) return;
                  void saveSkill(editing.name.trim(), editing.description.trim(), editing.content);
                  setEditing(null);
                }}
              >
                保存
              </Button>
            </div>
          </>
        )}
      </FormDialog>

      <ConfirmDialog
        open={deletingSkill !== null}
        onOpenChange={(open) => !open && setDeletingSkill(null)}
        title="删除技能？"
        description={deletingSkill ? `将从服务器删除技能 /${deletingSkill}。` : ""}
        confirmLabel="删除"
        destructive
        onConfirm={() => {
          if (deletingSkill) void deleteSkill(deletingSkill);
          setDeletingSkill(null);
        }}
      />
    </div>
  );
}
