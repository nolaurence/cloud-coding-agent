import { FormEvent, useState } from "react";
import { Navigate } from "react-router-dom";
import { Bot } from "lucide-react";
import { useApp } from "../lib/store";
import { Button, Input } from "../components/ui/primitives";

export function LoginPage() {
  const user = useApp((s) => s.user);
  const login = useApp((s) => s.login);
  const register = useApp((s) => s.register);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (mode === "register" && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      if (mode === "login") await login(username, password);
      else await register(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <div className="w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-8 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Bot className="h-10 w-10 text-blue-500" />
          <h1 className="text-lg font-semibold">Cloud Coding Agent</h1>
          <p className="text-xs text-zinc-500">{mode === "login" ? "登录你的账户" : "注册新账户"}</p>
        </div>
        <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
          <Input
            autoFocus
            placeholder="用户名"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
          <Input
            type="password"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
          {mode === "register" && (
            <Input
              type="password"
              placeholder="确认密码"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          )}
          {error && <div className="text-xs text-red-500">{error}</div>}
          <Button type="submit" disabled={busy || !username.trim() || !password} className="mt-1 w-full">
            {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并登录"}
          </Button>
        </form>
        <div className="mt-4 text-center text-xs text-zinc-500">
          {mode === "login" ? (
            <button className="text-blue-500 hover:underline" onClick={() => { setMode("register"); setError(""); }}>
              没有账户?注册
            </button>
          ) : (
            <button className="text-blue-500 hover:underline" onClick={() => { setMode("login"); setError(""); }}>
              已有账户?登录
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
