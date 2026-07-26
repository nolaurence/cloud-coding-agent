import crypto from "node:crypto";
import fs from "node:fs";
import type { GitBinding, GitProvider } from "@cca/protocol";
import { GIT_BINDINGS_FILE, SECRET_FILE } from "./env.js";

interface StoredBinding extends GitBinding {
  encryptedToken: string;
}

type StoredBindings = Record<string, Partial<Record<GitProvider, StoredBinding>>>;

function load(): StoredBindings {
  try {
    return fs.existsSync(GIT_BINDINGS_FILE)
      ? (JSON.parse(fs.readFileSync(GIT_BINDINGS_FILE, "utf8")) as StoredBindings)
      : {};
  } catch {
    return {};
  }
}

function save(bindings: StoredBindings) {
  const temp = `${GIT_BINDINGS_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(bindings, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, GIT_BINDINGS_FILE);
}

function encrypt(token: string): string {
  const key = crypto.createHash("sha256").update(fs.readFileSync(SECRET_FILE)).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

export function listGitBindings(ownerId: string): GitBinding[] {
  return Object.values(load()[ownerId] ?? {})
    .filter((binding): binding is StoredBinding => Boolean(binding))
    .map(({ encryptedToken: _, ...binding }) => binding);
}

export async function bindGitProvider(
  ownerId: string,
  provider: GitProvider,
  token: string,
): Promise<GitBinding> {
  const normalizedToken = token.trim();
  if (!normalizedToken || normalizedToken.length > 512) throw new Error("访问令牌无效");
  const endpoint = provider === "github" ? "https://api.github.com/user" : "https://gitee.com/api/v5/user";
  const authorization = provider === "github" ? `Bearer ${normalizedToken}` : `token ${normalizedToken}`;
  const response = await fetch(endpoint, {
    headers: {
      Authorization: authorization,
      Accept: provider === "github" ? "application/vnd.github+json" : "application/json",
      "User-Agent": "cloud-coding-agent",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`${provider === "github" ? "GitHub" : "Gitee"} 令牌验证失败 (${response.status})`);
  }
  const profile = (await response.json()) as {
    login?: string;
    name?: string;
    avatar_url?: string;
    html_url?: string;
  };
  const username = profile.login ?? profile.name;
  if (!username) throw new Error("平台未返回用户信息");
  const binding: GitBinding = {
    provider,
    username,
    avatarUrl: profile.avatar_url,
    profileUrl:
      profile.html_url ??
      (provider === "github" ? `https://github.com/${username}` : `https://gitee.com/${username}`),
    connectedAt: Date.now(),
  };
  const all = load();
  all[ownerId] = {
    ...all[ownerId],
    [provider]: { ...binding, encryptedToken: encrypt(normalizedToken) },
  };
  save(all);
  return binding;
}

export function unbindGitProvider(ownerId: string, provider: GitProvider) {
  const all = load();
  if (!all[ownerId]?.[provider]) return;
  delete all[ownerId][provider];
  if (Object.keys(all[ownerId]).length === 0) delete all[ownerId];
  save(all);
}
