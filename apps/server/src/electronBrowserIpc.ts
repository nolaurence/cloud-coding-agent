import type { BrowserStatus, BrowserUseArgs } from "./browser.js";

export const BROWSER_IPC_CHANNEL = "cca-browser";
export const BROWSER_IPC_TIMEOUT_MS = 35_000;

export type BrowserInspectResult = {
  url: string;
  title: string;
  elements: Array<{ ref: string; tag: string; text: string; type?: string }>;
  text: string;
};

export type BrowserIpcOperation =
  | { operation: "start" }
  | { operation: "run"; args: BrowserUseArgs }
  | { operation: "stop" }
  | { operation: "redeem-ticket"; ticket: string };

export interface BrowserIpcRequest {
  channel: typeof BROWSER_IPC_CHANNEL;
  kind: "request";
  requestId: string;
  threadId: string;
  payload: BrowserIpcOperation;
}

export interface BrowserIpcResponse {
  channel: typeof BROWSER_IPC_CHANNEL;
  kind: "response";
  requestId: string;
  ok: boolean;
  result?: BrowserInspectResult | BrowserStatus | { authorized: true } | null;
  error?: string;
}

const ACTIONS = new Set(["navigate", "inspect", "click", "type", "press", "scroll", "back", "forward", "reload"]);

export function isBrowserUseArgs(value: unknown): value is BrowserUseArgs {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (typeof item.action !== "string" || !ACTIONS.has(item.action)) return false;
  for (const key of ["url", "ref", "selector", "text", "key"] as const) {
    if (item[key] !== undefined && typeof item[key] !== "string") return false;
  }
  return item.direction === undefined || item.direction === "up" || item.direction === "down";
}

export function isBrowserIpcRequest(value: unknown): value is BrowserIpcRequest {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (item.channel !== BROWSER_IPC_CHANNEL || item.kind !== "request" || typeof item.requestId !== "string" ||
      !item.requestId || typeof item.threadId !== "string" || !item.threadId || !item.payload || typeof item.payload !== "object") return false;
  const payload = item.payload as Record<string, unknown>;
  if (payload.operation === "start" || payload.operation === "stop") return true;
  if (payload.operation === "run") return isBrowserUseArgs(payload.args);
  return payload.operation === "redeem-ticket" && typeof payload.ticket === "string" && payload.ticket.length > 0;
}

function isBrowserIpcResult(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (item.authorized === true) return true;
  if (typeof item.enabled === "boolean" && typeof item.ready === "boolean" && typeof item.starting === "boolean") {
    return item.error === undefined || typeof item.error === "string";
  }
  if (typeof item.url !== "string" || typeof item.title !== "string" || typeof item.text !== "string" || !Array.isArray(item.elements)) return false;
  return item.elements.every((element) => {
    if (!element || typeof element !== "object") return false;
    const entry = element as Record<string, unknown>;
    return typeof entry.ref === "string" && typeof entry.tag === "string" && typeof entry.text === "string" &&
      (entry.type === undefined || typeof entry.type === "string");
  });
}

export function isBrowserIpcResponse(value: unknown): value is BrowserIpcResponse {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (item.channel !== BROWSER_IPC_CHANNEL || item.kind !== "response" || typeof item.requestId !== "string" ||
      typeof item.ok !== "boolean" || (item.error !== undefined && typeof item.error !== "string")) return false;
  return item.ok ? isBrowserIpcResult(item.result) : typeof item.error === "string";
}
