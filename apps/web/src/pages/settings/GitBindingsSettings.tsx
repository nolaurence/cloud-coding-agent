import { useEffect, useState, type FormEvent } from "react";
import {
  CheckCircle2,
  Eye,
  EyeOff,
  GitBranch,
  Github,
  Loader2,
  Unlink,
} from "lucide-react";
import type { GitBinding, GitProvider } from "@cca/protocol";
import { request } from "../../lib/client";
import { Button, Input } from "../../components/ui/primitives";

const providers: { id: GitProvider; name: string; description: string }[] = [
  { id: "github", name: "GitHub", description: "Personal Access Token" },
  { id: "gitee", name: "Gitee", description: "私人令牌" },
];

const emptyTokens: Record<GitProvider, string> = { github: "", gitee: "" };
const hiddenTokens: Record<GitProvider, boolean> = { github: false, gitee: false };

function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

export function GitBindingsSettings() {
  const [bindings, setBindings] = useState<GitBinding[]>([]);
  const [tokens, setTokens] = useState<Record<GitProvider, string>>(emptyTokens);
  const [revealed, setRevealed] = useState<Record<GitProvider, boolean>>(hiddenTokens);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<GitProvider | null>(null);
  const [error, setError] = useState("");

  const load = async () => {
    try {
      setBindings(await request<GitBinding[]>({ type: "git.bindings" }));
    } catch (reason) {
      setError(errorMessage(reason, "无法读取代码托管账号"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const bind = async (provider: GitProvider) => {
    setBusy(provider);
    setError("");
    try {
      await request({ type: "git.bind", provider, token: tokens[provider] });
      setTokens((value) => ({ ...value, [provider]: "" }));
      setRevealed((value) => ({ ...value, [provider]: false }));
      await load();
    } catch (reason) {
      setError(errorMessage(reason, "绑定失败"));
    } finally {
      setBusy(null);
    }
  };

  const submit = (event: FormEvent, provider: GitProvider) => {
    event.preventDefault();
    if (tokens[provider].trim() && busy === null) void bind(provider);
  };

  const unbind = async (provider: GitProvider, name: string) => {
    if (!window.confirm(`解除 ${name} 账号绑定？`)) return;
    setBusy(provider);
    setError("");
    try {
      await request({ type: "git.unbind", provider });
      await load();
    } catch (reason) {
      setError(errorMessage(reason, "解除绑定失败"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="git-bindings-title" className="space-y-3">
      <div>
        <h2 id="git-bindings-title" className="text-base font-semibold">
          代码托管账户
        </h2>
        <p className="mt-1 text-sm text-zinc-500">
          绑定后，Agent 可按任务访问已授权仓库并执行 clone、pull、push。令牌由服务端加密保存。
        </p>
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/30 dark:text-red-400"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="space-y-3" aria-label="正在读取代码托管账户">
          {providers.map((provider) => (
            <div
              key={provider.id}
              className="h-28 animate-pulse rounded-lg border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60"
            />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {providers.map((provider) => {
            const binding = bindings.find((item) => item.provider === provider.id);
            const titleId = `git-provider-${provider.id}`;
            return (
              <section
                key={provider.id}
                aria-labelledby={titleId}
                className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800"
              >
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900">
                    {provider.id === "github" ? (
                      <Github className="h-5 w-5" />
                    ) : (
                      <GitBranch className="h-5 w-5 text-red-600 dark:text-red-400" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 id={titleId} className="text-sm font-medium">
                      {provider.name}
                    </h3>
                    <div className="text-xs text-zinc-500">{provider.description}</div>
                  </div>
                  {binding && (
                    <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" /> 已连接
                    </span>
                  )}
                </div>

                {binding ? (
                  <div className="mt-4 flex flex-col gap-3 rounded-md bg-zinc-50 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between dark:bg-zinc-900">
                    <a
                      href={binding.profileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="flex min-w-0 items-center gap-2 text-sm font-medium hover:underline"
                    >
                      {binding.avatarUrl && (
                        <img
                          src={binding.avatarUrl}
                          alt=""
                          className="h-7 w-7 shrink-0 rounded-full bg-zinc-200 object-cover dark:bg-zinc-700"
                        />
                      )}
                      <span className="min-w-0 truncate">@{binding.username}</span>
                    </a>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="min-h-9 shrink-0 self-stretch sm:self-auto"
                      disabled={busy !== null}
                      onClick={() => void unbind(provider.id, provider.name)}
                    >
                      {busy === provider.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Unlink className="h-3.5 w-3.5" />
                      )}
                      解除绑定
                    </Button>
                  </div>
                ) : (
                  <form
                    className="mt-4 flex flex-col gap-2 sm:flex-row"
                    onSubmit={(event) => submit(event, provider.id)}
                  >
                    <div className="relative min-w-0 flex-1">
                      <label className="sr-only" htmlFor={`git-token-${provider.id}`}>
                        {provider.name} 访问令牌
                      </label>
                      <Input
                        id={`git-token-${provider.id}`}
                        type={revealed[provider.id] ? "text" : "password"}
                        className="pr-10"
                        autoComplete="new-password"
                        autoCapitalize="none"
                        spellCheck={false}
                        maxLength={512}
                        placeholder="粘贴具有仓库读写权限的访问令牌"
                        value={tokens[provider.id]}
                        disabled={busy !== null}
                        onChange={(event) =>
                          setTokens((value) => ({ ...value, [provider.id]: event.target.value }))
                        }
                      />
                      <button
                        type="button"
                        title={revealed[provider.id] ? "隐藏令牌" : "显示令牌"}
                        aria-label={revealed[provider.id] ? "隐藏令牌" : "显示令牌"}
                        className="absolute top-0 right-0 flex h-9 w-10 items-center justify-center text-zinc-400 hover:text-zinc-700 disabled:opacity-50 dark:hover:text-zinc-200"
                        disabled={busy !== null}
                        onClick={() =>
                          setRevealed((value) => ({ ...value, [provider.id]: !value[provider.id] }))
                        }
                      >
                        {revealed[provider.id] ? (
                          <EyeOff className="h-4 w-4" />
                        ) : (
                          <Eye className="h-4 w-4" />
                        )}
                      </button>
                    </div>
                    <Button
                      type="submit"
                      className="w-full shrink-0 sm:w-auto"
                      disabled={!tokens[provider.id].trim() || busy !== null}
                    >
                      {busy === provider.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      绑定
                    </Button>
                  </form>
                )}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}
