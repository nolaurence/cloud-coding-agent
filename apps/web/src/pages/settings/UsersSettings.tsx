import { useEffect, useState } from "react";
import type { AdminRegistrationState, AdminUser, CreatedInvite } from "@cca/protocol";
import { Check, Copy, Loader2, Plus, ShieldCheck, Trash2, UserRound } from "lucide-react";
import { useApp } from "../../lib/store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function formatDate(value: number) {
  return dateFormatter.format(new Date(value));
}

async function copyText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

export function UsersSettings() {
  const currentUser = useApp((state) => state.user);
  const getAdminUsers = useApp((state) => state.getAdminUsers);
  const setUserRole = useApp((state) => state.setUserRole);
  const getAdminRegistration = useApp((state) => state.getAdminRegistration);
  const setInviteRequired = useApp((state) => state.setInviteRequired);
  const createInvite = useApp((state) => state.createInvite);
  const revokeInvite = useApp((state) => state.revokeInvite);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [registration, setRegistration] = useState<AdminRegistrationState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [updatingUser, setUpdatingUser] = useState<string | null>(null);
  const [updatingPolicy, setUpdatingPolicy] = useState(false);
  const [creatingInvite, setCreatingInvite] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<AdminRegistrationState["invites"][number] | null>(null);
  const [createdInvite, setCreatedInvite] = useState<CreatedInvite | null>(null);
  const [copied, setCopied] = useState(false);

  const loadData = async () => {
    setLoading(true);
    setError("");
    try {
      const [nextUsers, nextRegistration] = await Promise.all([
        getAdminUsers(),
        getAdminRegistration(),
      ]);
      setUsers(nextUsers);
      setRegistration(nextRegistration);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "无法加载用户管理设置");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const updateRole = async (managedUser: AdminUser, role: AdminUser["role"]) => {
    if (managedUser.role === role || updatingUser) return;
    setUpdatingUser(managedUser.username);
    setError("");
    try {
      const updated = await setUserRole(managedUser.username, role);
      setUsers((existing) =>
        existing.map((candidate) =>
          candidate.username === updated.username ? updated : candidate,
        ),
      );
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "修改用户角色失败");
    } finally {
      setUpdatingUser(null);
    }
  };

  const updateRegistrationPolicy = async (inviteRequired: boolean) => {
    if (updatingPolicy) return;
    setUpdatingPolicy(true);
    setError("");
    try {
      setRegistration(await setInviteRequired(inviteRequired));
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : "修改注册设置失败");
    } finally {
      setUpdatingPolicy(false);
    }
  };

  const generateInvite = async () => {
    if (creatingInvite) return;
    setCreatingInvite(true);
    setError("");
    try {
      const invite = await createInvite();
      setRegistration((existing) =>
        existing ? { ...existing, invites: [invite, ...existing.invites] } : existing,
      );
      setCopied(false);
      setCreatedInvite(invite);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "创建邀请码失败");
    } finally {
      setCreatingInvite(false);
    }
  };

  const confirmRevoke = async () => {
    const target = revokeTarget;
    setRevokeTarget(null);
    if (!target) return;
    setError("");
    try {
      await revokeInvite(target.id);
      setRegistration((existing) =>
        existing
          ? { ...existing, invites: existing.invites.filter((invite) => invite.id !== target.id) }
          : existing,
      );
    } catch (revokeError) {
      setError(revokeError instanceof Error ? revokeError.message : "撤销邀请码失败");
    }
  };

  if (loading) {
    return (
      <div className="flex min-h-48 items-center justify-center text-zinc-400">
        <Loader2 className="h-5 w-5 animate-spin" aria-label="正在加载" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-7">
      {error && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-950 dark:bg-red-950/30 dark:text-red-300"
        >
          <div className="flex items-center justify-between gap-3">
            <span>{error}</span>
            {!registration && (
              <Button variant="outline" size="sm" onClick={() => void loadData()}>
                重试
              </Button>
            )}
          </div>
        </div>
      )}

      {registration && (
        <section>
          <div className="mb-3">
            <h2 className="text-base font-semibold">注册设置</h2>
            <p className="text-xs text-zinc-500">控制新用户是否必须使用有效邀请码注册</p>
          </div>

          <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
            <div className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium">要求邀请码</div>
                <div className="text-xs text-zinc-500">
                  关闭后，任何人都可以直接创建普通用户账户
                </div>
              </div>
              <Switch
                checked={registration.inviteRequired}
                disabled={updatingPolicy}
                aria-label="要求邀请码注册"
                onCheckedChange={(checked) => void updateRegistrationPolicy(checked)}
              />
            </div>

            <div className="border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">有效邀请码</div>
                  <div className="text-xs text-zinc-500">完整邀请码仅在创建时显示</div>
                </div>
                <Button size="sm" disabled={creatingInvite} onClick={() => void generateInvite()}>
                  {creatingInvite ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Plus className="h-3.5 w-3.5" />
                  )}
                  创建邀请码
                </Button>
              </div>

              {registration.inviteRequired && registration.invites.length === 0 && (
                <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-300">
                  当前没有有效邀请码，新用户暂时无法注册。
                </div>
              )}

              {registration.invites.length === 0 ? (
                <div className="py-4 text-center text-sm text-zinc-500">还没有邀请码</div>
              ) : (
                <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
                  {registration.invites.map((invite) => (
                    <div key={invite.id} className="flex items-center gap-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-sm">{invite.hint}</div>
                        <div className="truncate text-xs text-zinc-500">
                          {invite.createdBy} 创建于 {formatDate(invite.createdAt)}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`撤销邀请码 ${invite.hint}`}
                        title="撤销邀请码"
                        onClick={() => setRevokeTarget(invite)}
                      >
                        <Trash2 className="h-4 w-4 text-red-500" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      <section>
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">注册用户</h2>
            <p className="text-xs text-zinc-500">管理员可以调整其他用户的系统角色</p>
          </div>
          <Badge variant="secondary">{users.length} 位用户</Badge>
        </div>

        <div className="overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800">
          {users.length === 0 ? (
            <div className="p-6 text-center text-sm text-zinc-500">暂无注册用户</div>
          ) : (
            <div className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {users.map((managedUser) => {
                const isCurrent = managedUser.username === currentUser?.username;
                const roleLocked = managedUser.protected || isCurrent;
                return (
                  <div
                    key={managedUser.username}
                    className="flex flex-wrap items-center gap-3 px-4 py-3"
                  >
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-zinc-100 dark:bg-zinc-800">
                      {managedUser.role === "admin" ? (
                        <ShieldCheck className="h-4 w-4 text-blue-500" />
                      ) : (
                        <UserRound className="h-4 w-4 text-zinc-500" />
                      )}
                    </div>
                    <div className="min-w-40 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{managedUser.username}</span>
                        {isCurrent && <Badge variant="outline">当前账户</Badge>}
                        {managedUser.protected && <Badge variant="outline">初始管理员</Badge>}
                      </div>
                      <div className="text-xs text-zinc-500">
                        注册于 {formatDate(managedUser.createdAt)}
                      </div>
                    </div>
                    <Select
                      value={managedUser.role}
                      disabled={roleLocked || updatingUser !== null}
                      onValueChange={(role) =>
                        void updateRole(managedUser, role as AdminUser["role"])
                      }
                    >
                      <SelectTrigger
                        className="w-28"
                        aria-label={`设置 ${managedUser.username} 的角色`}
                        title={
                          managedUser.protected
                            ? "初始管理员角色受保护"
                            : isCurrent
                              ? "不能修改自己的角色"
                              : undefined
                        }
                      >
                        {updatingUser === managedUser.username ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <SelectValue />
                        )}
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user">普通用户</SelectItem>
                        <SelectItem value="admin">管理员</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <Dialog
        open={createdInvite !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreatedInvite(null);
            setCopied(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>邀请码已创建</DialogTitle>
            <DialogDescription>完整邀请码仅显示这一次，请立即发送给需要注册的用户。</DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Input readOnly className="font-mono" value={createdInvite?.code ?? ""} />
            <Button
              variant="outline"
              size="icon"
              aria-label={copied ? "已复制" : "复制邀请码"}
              title={copied ? "已复制" : "复制邀请码"}
              onClick={() => {
                if (!createdInvite) return;
                void copyText(createdInvite.code)
                  .then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1600);
                  })
                  .catch(() => setError("无法复制邀请码，请手动复制"));
              }}
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title="撤销邀请码？"
        description={
          revokeTarget
            ? `邀请码 ${revokeTarget.hint} 将立即失效，之后不能再用于注册。`
            : ""
        }
        confirmLabel="撤销"
        destructive
        onConfirm={() => void confirmRevoke()}
      />
    </div>
  );
}
