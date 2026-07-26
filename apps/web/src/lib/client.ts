import type { ClientMessage, ServerMessage } from "@cca/protocol";

type EventHandler = (msg: ServerMessage) => void;

let socket: WebSocket | null = null;
let seq = 0;
let currentToken: string | null = null;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const handlers = new Set<EventHandler>();
const reconnectListeners = new Set<() => void>();
const authFailListeners = new Set<() => void>();
const connectionListeners = new Set<(connected: boolean) => void>();
let reconnectDelay = 500;
let closed = false;

export function connect(token: string) {
  if (socket && currentToken === token) return;
  disconnect();
  closed = false;
  currentToken = token;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws?token=${encodeURIComponent(token)}`;
  socket = new WebSocket(url);

  socket.onopen = () => {
    reconnectDelay = 500;
    connectionListeners.forEach((fn) => fn(true));
    reconnectListeners.forEach((fn) => fn());
  };
  socket.onmessage = (ev) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data as string) as ServerMessage;
    } catch {
      return;
    }
    if (msg.type === "auth.error") {
      authFailListeners.forEach((fn) => fn());
      return;
    }
    if (msg.type === "reply") {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        if (msg.ok) entry.resolve(msg.data);
        else entry.reject(new Error(msg.error));
      }
      return;
    }
    handlers.forEach((h) => h(msg));
  };
  socket.onclose = (ev) => {
    socket = null;
    connectionListeners.forEach((fn) => fn(false));
    for (const [, entry] of pending) {
      entry.reject(new Error("连接已断开"));
    }
    pending.clear();
    if (ev.code === 4401) {
      authFailListeners.forEach((fn) => fn());
      return;
    }
    if (!closed && currentToken) {
      setTimeout(() => {
        if (currentToken) connect(currentToken);
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    }
  };
  socket.onerror = () => {
    socket?.close();
  };
}

export function disconnect() {
  closed = true;
  currentToken = null;
  socket?.close();
  socket = null;
  connectionListeners.forEach((fn) => fn(false));
}

export function onAuthFail(fn: () => void) {
  authFailListeners.add(fn);
  return () => authFailListeners.delete(fn);
}

export function onReconnect(fn: () => void) {
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}

export function onConnectionChange(fn: (connected: boolean) => void) {
  connectionListeners.add(fn);
  return () => connectionListeners.delete(fn);
}

export function onEvent(handler: EventHandler) {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

type ClientMessageNoId = ClientMessage extends infer T
  ? T extends { id: string }
    ? Omit<T, "id">
    : never
  : never;

export function request<T = unknown>(msg: ClientMessageNoId): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      reject(new Error("未连接到服务器"));
      return;
    }
    const id = `req-${++seq}`;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    socket.send(JSON.stringify({ ...msg, id }));
  });
}

export async function uploadImage(file: File): Promise<{ path: string; displayName: string; imageId: string }> {
  if (!currentToken) throw new Error("未登录");
  const response = await fetch("/api/uploads/images", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${currentToken}`,
      "Content-Type": file.type,
      "X-File-Name": encodeURIComponent(file.name),
    },
    body: file,
  });
  const data = (await response.json().catch(() => ({}))) as {
    path?: string;
    displayName?: string;
    id?: string;
    error?: string;
  };
  if (!response.ok || !data.path || !data.id) {
    throw new Error(data.error ?? `图片上传失败 (${response.status})`);
  }
  return { path: data.path, displayName: data.displayName ?? file.name, imageId: data.id };
}

export async function loadImage(id: string, threadId: string, signal?: AbortSignal): Promise<Blob> {
  if (!currentToken) throw new Error("未登录");
  const response = await fetch(
    `/api/uploads/images/${encodeURIComponent(id)}?threadId=${encodeURIComponent(threadId)}`,
    {
    headers: { Authorization: `Bearer ${currentToken}` },
    signal,
    },
  );
  if (!response.ok) throw new Error(`图片加载失败 (${response.status})`);
  return response.blob();
}
