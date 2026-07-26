import { useEffect, useState } from "react";
import { Github, GitBranch, Loader2, Unlink } from "lucide-react";
import type { GitBinding, GitProvider } from "@cca/protocol";
import { request } from "../../lib/client";
import { Button, Input } from "../../components/ui/primitives";

const providers: { id: GitProvider; name: string; description: string }[] = [
  { id: "github", name: "GitHub", description: "使用 Personal Access Token 绑定 GitHub 账号" },
  { id: "gitee", name: "Gitee", description: "使用私人令牌绑定 Gitee 账号" },
];

export function GitBindingsSettings() {
  const [bindings, setBindings] = useState<GitBinding[]>([]);
  const [tokens, setTokens] = useState<Record<GitProvider, string>>({ github: "", gitee: "" });
  const [busy, setBusy] = useState<GitProvider | null>(null);
  const [error, setError] = useState("");

  const load = () => request<GitBinding[]>({ type: "git.bindings" }).then(setBindings).catch((reason) => setError(reason.message));
  useEffect(() => { void load(); }, []);

  const bind = async (provider: GitProvider) => {
    setBusy(provider);
    setError("");
    try {
      await request({ type: "git.bind", provider, token: tokens[provider] });
      setTokens((value) => ({ ...value, [provider]: "" }));
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "绑定失败");
    } finally {
      setBusy(null);
    }
  };

  const unbind = async (provider: GitProvider) => {
    setBusy(provider);
    try {
      await request({ type: "git.unbind", provider });
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold">代码托管</h2>
        <p className="mt-1 text-sm text-zinc-500">令牌验证后使用服务器密钥加密保存，不会返回到浏览器。</p>
      </div>
      {error && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-600 dark:bg-red-950/30 dark:text-red-400">{error}</div>}
      {providers.map((provider) => {
        const binding = bindings.find((item) => item.provider === provider.id);
        return (
          <section key={provider.id} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
            <div className="flex items-start gap-3">
              {provider.id === "github" ? <Github className="h-5 w-5" /> : <GitBranch className="h-5 w-5" />}
              <div className="min-w-0 flex-1">
                <div className="font-medium">{provider.name}</div>
                <div className="text-xs text-zinc-500">{provider.description}</div>
              </div>
            </div>
            {binding ? (
              <div className="mt-4 flex items-center justify-between rounded-md bg-zinc-50 px-3 py-2 dark:bg-zinc-900">
                <a href={binding.profileUrl} target="_blank" rel="noreferrer" className="text-sm font-medium hover:underline">已绑定 @{binding.username}</a>
                <Button size="sm" variant="outline" disabled={busy === provider.id} onClick={() => void unbind(provider.id)}><Unlink className="h-3.5 w-3.5" />解除绑定</Button>
              </div>
            ) : (
              <div className="mt-4 flex gap-2">
                <Input type="password" autoComplete="off" placeholder="粘贴访问令牌" value={tokens[provider.id]} onChange={(event) => setTokens((value) => ({ ...value, [provider.id]: event.target.value }))} />
                <Button disabled={!tokens[provider.id].trim() || busy === provider.id} onClick={() => void bind(provider.id)}>{busy === provider.id && <Loader2 className="h-3.5 w-3.5 animate-spin" />}绑定</Button>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
