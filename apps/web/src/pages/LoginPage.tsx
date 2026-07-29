import { FormEvent, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useApp } from "../lib/store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BrandLogo } from "../components/BrandLogo";

export function LoginPage() {
  const user = useApp((s) => s.user);
  const login = useApp((s) => s.login);
  const register = useApp((s) => s.register);
  const getRegistrationPolicy = useApp((s) => s.getRegistrationPolicy);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [inviteRequired, setInviteRequired] = useState(false);
  const [policyLoading, setPolicyLoading] = useState(true);
  const [policyError, setPolicyError] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const loadRegistrationPolicy = async () => {
    setPolicyLoading(true);
    setPolicyError("");
    try {
      const policy = await getRegistrationPolicy();
      setInviteRequired(policy.inviteRequired);
    } catch (loadError) {
      setPolicyError(
        loadError instanceof Error ? loadError.message : "无法获取注册设置",
      );
    } finally {
      setPolicyLoading(false);
    }
  };

  useEffect(() => {
    void loadRegistrationPolicy();
  }, []);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (mode === "register" && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    if (mode === "register" && (policyLoading || policyError)) {
      setError("注册设置尚未就绪，请稍后重试");
      return;
    }
    if (mode === "register" && inviteRequired && !inviteCode.trim()) {
      setError("请输入邀请码");
      return;
    }
    setBusy(true);
    try {
      if (mode === "login") await login(username, password);
      else await register(username, password, inviteRequired ? inviteCode.trim() : undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
      if (mode === "register") void loadRegistrationPolicy();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-white px-6 dark:bg-zinc-950">
      <div className="w-full max-w-sm py-10">
        <div className="mb-7 flex flex-col items-center gap-2">
          <BrandLogo className="mb-1 h-14 w-14" />
          <h1 className="text-lg font-semibold">云端编码助手</h1>
          <p className="text-xs text-zinc-500">
            {mode === "login" ? "登录以继续" : "创建新账户"}
          </p>
        </div>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <Input
            autoFocus
            aria-label="用户名"
            placeholder="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
          <Input
            type="password"
            aria-label="密码"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
          {mode === "register" && (
            <>
              <Input
                type="password"
                aria-label="确认密码"
                placeholder="确认密码"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
              />
              {policyLoading && (
                <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  正在检查注册要求
                </div>
              )}
              {!policyLoading && policyError && (
                <div className="flex items-center justify-between gap-2 text-xs text-red-500" role="alert">
                  <span>{policyError}</span>
                  <Button
                    type="button"
                    variant="link"
                    className="h-auto shrink-0 px-0 text-xs"
                    onClick={() => void loadRegistrationPolicy()}
                  >
                    重试
                  </Button>
                </div>
              )}
              {!policyLoading && !policyError && inviteRequired && (
                <Input
                  aria-label="邀请码"
                  placeholder="邀请码"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                  autoComplete="one-time-code"
                  spellCheck={false}
                />
              )}
            </>
          )}
          {error && (
            <div className="text-xs text-red-500" role="alert">
              {error}
            </div>
          )}
          <Button
            type="submit"
            disabled={
              busy ||
              !username.trim() ||
              !password ||
              (mode === "register" &&
                (policyLoading || Boolean(policyError) || (inviteRequired && !inviteCode.trim())))
            }
            className="mt-1 w-full"
          >
            {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并登录"}
          </Button>
        </form>
        <div className="mt-4 text-center text-xs text-zinc-500">
          {mode === "login" ? (
            <Button
              type="button"
              variant="link"
              className="h-auto px-0 text-xs font-normal"
              onClick={() => {
                setMode("register");
                setError("");
              }}
            >
              没有账户？注册
            </Button>
          ) : (
            <Button
              type="button"
              variant="link"
              className="h-auto px-0 text-xs font-normal"
              onClick={() => {
                setMode("login");
                setError("");
                setInviteCode("");
              }}
            >
              已有账户？登录
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
