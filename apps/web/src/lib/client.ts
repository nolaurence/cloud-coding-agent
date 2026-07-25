import type { ClientMessage, ServerMessage } from "@cca/protocol";

type EventHandler = (msg: ServerMessage) => void;

type ClientMessageNoId = ClientMessage extends infer T
  ? T extends { id: string }
    ? Omit<T, "id">
    : never
  : never;

let socket: WebSocket | null = null;
let seq = 0;
const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const handlers = new Set<EventHandler>();
const reconnectListeners = new Set<() => void>();
let reconnectDelay = 500;
let closed = false;

export function connect() {
  closed = false;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}/ws`;
  socket = new WebSocket(url);

  socket.onopen = () => {
    reconnectDelay = 500;
    reconnectListeners.forEach((fn) => fn());
  };
  socket.onmessage = (ev) => {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(ev.data as string) as ServerMessage;
    } catch {
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
  socket.onclose = () => {
    socket = null;
    for (const [, entry] of pending) {
      entry.reject(new Error("连接已断开"));
    }
    pending.clear();
    if (!closed) {
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 8000);
    }
  };
  socket.onerror = () => {
    socket?.close();
  };
}

export function onReconnect(fn: () => void) {
  reconnectListeners.add(fn);
  return () => reconnectListeners.delete(fn);
}

export function onEvent(handler: EventHandler) {
  handlers.add(handler);
  return () => handlers.delete(handler);
}

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
