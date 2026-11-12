import type { DshProviderRoute } from "./dshConfig.js";

export function credentialEnvName(providerId: string): string {
  return "CCA_DSH_KEY_" + providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

const DEEPSEEK_SEARCH_PATH = "/anthropic/v1";
const OFFICIAL_SEARCH_BASE = "https://api.deepseek.com/anthropic/v1";

/** DSH `web_search` reads `DEEPSEEK_API_KEY` / `DEEPSEEK_SEARCH_BASE_URL`, not the chat route's apiKeyEnv. */
export const DSH_SEARCH_API_KEY_ENV = "DEEPSEEK_API_KEY";
export const DSH_SEARCH_BASE_URL_ENV = "DEEPSEEK_SEARCH_BASE_URL";

/**
 * Derive the Anthropic-compatible search base from a chat completions URL when
 * the host is DeepSeek official. Custom gateways are not guessed: set
 * `CCA_DSH_SEARCH_BASE_URL` (or `DEEPSEEK_SEARCH_BASE_URL`) to the Messages API
 * root if search must hit a non-official endpoint.
 */
export function deepseekSearchBaseUrl(chatBaseUrl: string | undefined): string | undefined {
  if (!chatBaseUrl?.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(chatBaseUrl.trim());
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (host === "api.deepseek.com" || host.endsWith(".deepseek.com")) return OFFICIAL_SEARCH_BASE;
  return undefined;
}

function searchBaseUrlFromEnv(source: NodeJS.ProcessEnv): string | undefined {
  const configured = source.CCA_DSH_SEARCH_BASE_URL?.trim() || source.DEEPSEEK_SEARCH_BASE_URL?.trim();
  if (!configured) return undefined;
  try {
    const url = new URL(configured);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password) return undefined;
    return configured.replace(/\/+$/, "") || undefined;
  } catch {
    return undefined;
  }
}

/** Env vars injected into the DSH runtime: chat route key plus the search alias DSH actually reads. */
export function dshRuntimeCredentials(
  route: DshProviderRoute,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const credentials: Record<string, string> = {};
  if (route.apiKey) {
    credentials[credentialEnvName(route.id)] = route.apiKey;
    credentials[DSH_SEARCH_API_KEY_ENV] = route.apiKey;
  }
  const searchBase = searchBaseUrlFromEnv(source) ?? deepseekSearchBaseUrl(route.baseUrl);
  if (searchBase) credentials[DSH_SEARCH_BASE_URL_ENV] = searchBase.endsWith(DEEPSEEK_SEARCH_PATH)
    ? searchBase
    : searchBase.replace(/\/+$/, "");
  return credentials;
}

export function dshSearchPatch(route: DshProviderRoute | undefined, source: NodeJS.ProcessEnv = process.env): {
  id: string;
  config: { apiKeyEnv: string; model: string; apiVersion: string; maxTokens: number; maxUses: number; baseURL?: string };
} | undefined {
  if (!route) return undefined;
  const searchBase = searchBaseUrlFromEnv(source) ?? deepseekSearchBaseUrl(route.baseUrl);
  return {
    id: "web-search-deepseek",
    config: {
      apiKeyEnv: route.apiKey ? credentialEnvName(route.id) : DSH_SEARCH_API_KEY_ENV,
      model: "deepseek-v4-flash",
      apiVersion: "2023-06-01",
      maxTokens: 4096,
      maxUses: 5,
      ...(searchBase ? { baseURL: searchBase } : {}),
    },
  };
}
