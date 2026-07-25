import type { ModelEntry, ProviderModelDiscoveryConfig } from "@cca/protocol";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function buildProviderModelsUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    throw new Error("Base URL 格式无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Base URL 仅支持 HTTP 或 HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Base URL 不能包含用户名或密码");
  }

  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = `${path}/models`;
  url.hash = "";
  return url;
}

async function readBody(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("模型服务响应过大");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("模型服务响应过大");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function errorDetail(payload: unknown, fallbackBody: string): string {
  if (isRecord(payload)) {
    const error = payload.error;
    if (isRecord(error) && typeof error.message === "string") return error.message;
    if (typeof error === "string") return error;
    if (typeof payload.message === "string") return payload.message;
    if (typeof payload.detail === "string") return payload.detail;
  }
  return fallbackBody;
}

function sanitizeMessage(message: string, apiKey?: string): string {
  let sanitized = message.replace(/\s+/g, " ").trim();
  if (apiKey) sanitized = sanitized.split(apiKey).join("[已隐藏]");
  return sanitized.slice(0, 500);
}

function parseModels(payload: unknown): ModelEntry[] {
  const candidates = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : null;
  if (!candidates) throw new Error("模型服务返回的数据格式不受支持");

  const models = new Map<string, ModelEntry>();
  for (const candidate of candidates) {
    const id =
      typeof candidate === "string"
        ? candidate.trim()
        : isRecord(candidate) && typeof candidate.id === "string"
          ? candidate.id.trim()
          : "";
    if (!id || models.has(id)) continue;

    let name: string | undefined;
    if (isRecord(candidate)) {
      const rawName = candidate.name ?? candidate.display_name ?? candidate.displayName;
      if (typeof rawName === "string" && rawName.trim() && rawName.trim() !== id) {
        name = rawName.trim();
      }
    }
    models.set(id, { id, name });
  }

  return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export async function discoverProviderModels(
  provider: ProviderModelDiscoveryConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelEntry[]> {
  if (provider.type !== "openai") {
    throw new Error("当前仅支持自动获取 OpenAI 兼容服务的模型列表");
  }

  const apiKey = provider.apiKey?.trim() || undefined;
  const url = buildProviderModelsUrl(provider.baseUrl);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("获取模型超时,请检查 Base URL 和网络连接");
    }
    throw new Error(`无法连接模型服务: ${sanitizeMessage(message, apiKey)}`);
  }

  const body = await readBody(response);
  const payload = parseJson(body);
  if (!response.ok) {
    const detail = sanitizeMessage(errorDetail(payload, body), apiKey);
    throw new Error(`获取模型失败 (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  if (payload === undefined) throw new Error("模型服务返回了无效的 JSON");

  const models = parseModels(payload);
  if (models.length === 0) throw new Error("模型服务没有返回可用模型");
  return models;
}
