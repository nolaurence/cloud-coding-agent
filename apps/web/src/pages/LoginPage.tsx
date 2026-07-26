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
    <div className="flex h-full items-center justify-center bg-white px-6 dark:bg-zinc-950">
      <div className="w-full max-w-sm py-10">
        <div className="mb-7 flex flex-col items-center gap-2">
          <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900">
            <Bot className="h-5 w-5" />
          </div>
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
            <Input
              type="password"
              aria-label="确认密码"
              placeholder="确认密码"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
            />
          )}
          {error && (
            <div className="text-xs text-red-500" role="alert">
              {error}
            </div>
          )}
          <Button type="submit" disabled={busy || !username.trim() || !password} className="mt-1 w-full">
            {busy ? "请稍候…" : mode === "login" ? "登录" : "注册并登录"}
          </Button>
        </form>
        <div className="mt-4 text-center text-xs text-zinc-500">
          {mode === "login" ? (
            <button
              type="button"
              className="text-zinc-700 hover:underline dark:text-zinc-300"
              onClick={() => {
                setMode("register");
                setError("");
              }}
            >
              没有账户？注册
            </button>
          ) : (
            <button
              type="button"
              className="text-zinc-700 hover:underline dark:text-zinc-300"
              onClick={() => {
                setMode("login");
                setError("");
              }}
            >
              已有账户？登录
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
