import WebSocket from "ws";
import type { ConnectorConfig } from "@cca/protocol";
import type {
  ConnectorClient,
  ConnectorClientCallbacks,
  ConnectorTarget,
  InboundConnectorMessage,
} from "./types.js";
import {
  IMAGE_EXTENSIONS,
  MAX_IMAGE_SIZE,
  hasImageSignature,
  removeUploadedImages,
  storeUploadedImage,
} from "../uploads.js";

const API_BASE_URL = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const INTENTS = 2 ** 25 + 2 ** 12 + 2 ** 30;
const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];

interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

interface QQMessageAttachment {
  content_type?: string;
  filename?: string;
  size?: number | string;
  url?: string;
}

interface QQMessageData {
  id?: string;
  content?: string;
  channel_id?: string;
  group_openid?: string;
  attachments?: QQMessageAttachment[];
  author?: {
    id?: string;
    user_openid?: string;
    member_openid?: string;
  };
}

export interface QQImageAttachment {
  contentType?: string;
  filename?: string;
  size?: number;
  url: string;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number | string;
}

function chunks(text: string, size = 1_500): string[] {
  const out: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) out.push(text.slice(offset, offset + size));
  return out.length > 0 ? out : [""];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function supportedImageMimeType(value: string | undefined): keyof typeof IMAGE_EXTENSIONS | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (normalized === "image/jpg") return "image/jpeg";
  if (
    normalized === "image/jpeg" ||
    normalized === "image/png" ||
    normalized === "image/gif" ||
    normalized === "image/webp"
  ) {
    return normalized;
  }
  return null;
}

function filenameImageMimeType(filename: string | undefined): keyof typeof IMAGE_EXTENSIONS | null {
  const normalized = filename?.trim().toLowerCase() ?? "";
  if (/\.jpe?g$/.test(normalized)) return "image/jpeg";
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".gif")) return "image/gif";
  if (normalized.endsWith(".webp")) return "image/webp";
  return null;
}

export function getQQImageAttachments(data: QQMessageData): QQImageAttachment[] {
  return (data.attachments ?? []).flatMap((attachment) => {
    const url = attachment.url?.trim();
    const contentType = attachment.content_type?.trim();
    const filename = attachment.filename?.trim();
    if (!url || (!contentType?.toLowerCase().startsWith("image/") && !filenameImageMimeType(filename))) {
      return [];
    }
    const rawSize = Number(attachment.size);
    return [{
      url,
      ...(contentType ? { contentType } : {}),
      ...(filename ? { filename } : {}),
      ...(Number.isFinite(rawSize) && rawSize >= 0 ? { size: rawSize } : {}),
    }];
  });
}

async function readResponseBuffer(response: Response): Promise<Buffer> {
  const contentLengthValue = response.headers.get("content-length");
  if (contentLengthValue) {
    const contentLength = Number(contentLengthValue);
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_SIZE) {
      throw new Error("单张图片不能超过 10 MB");
    }
  }
  if (!response.body) return Buffer.alloc(0);

  const chunks: Buffer[] = [];
  let total = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_IMAGE_SIZE) {
      await reader.cancel("image exceeds size limit");
      throw new Error("单张图片不能超过 10 MB");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export async function fetchQQImage(
  attachment: QQImageAttachment,
  fetchImpl: typeof fetch = fetch,
): Promise<{ buffer: Buffer; displayName: string; mimeType: keyof typeof IMAGE_EXTENSIONS }> {
  if (attachment.size !== undefined && attachment.size > MAX_IMAGE_SIZE) {
    throw new Error("单张图片不能超过 10 MB");
  }

  let url: URL;
  try {
    url = new URL(attachment.url);
  } catch {
    throw new Error("QQ 图片地址无效");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("QQ 图片地址必须使用 HTTPS");
  }

  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`QQ 图片下载失败 (HTTP ${response.status})`);
  if (response.url) {
    const finalUrl = new URL(response.url);
    if (finalUrl.protocol !== "https:") throw new Error("QQ 图片下载被重定向到非 HTTPS 地址");
  }

  const buffer = await readResponseBuffer(response);
  const mimeType =
    supportedImageMimeType(response.headers.get("content-type") ?? undefined) ??
    supportedImageMimeType(attachment.contentType) ??
    filenameImageMimeType(attachment.filename);
  if (!mimeType) throw new Error("QQ 图片格式不受支持，仅支持 JPG、PNG、GIF 和 WebP");
  if (!hasImageSignature(buffer, mimeType)) throw new Error("QQ 图片内容与文件类型不匹配");
  return {
    buffer,
    mimeType,
    displayName: attachment.filename || "QQ图片" + IMAGE_EXTENSIONS[mimeType],
  };
}

export function normalizeQQMessage(type: string, data: QQMessageData): InboundConnectorMessage | null {
  const messageId = data.id?.trim();
  const text = data.content?.trim() ?? "";
  if (!messageId || (!text && getQQImageAttachments(data).length === 0)) return null;

  if (type === "C2C_MESSAGE_CREATE") {
    const senderId = data.author?.user_openid?.trim();
    if (!senderId) return null;
    return {
      eventId: messageId,
      messageId,
      conversationId: `private:${senderId}`,
      conversationLabel: `QQ 私聊 ${senderId}`,
      senderId,
      text,
      target: { platform: "qq", kind: "private", id: senderId },
    };
  }

  if (type === "GROUP_AT_MESSAGE_CREATE") {
    const senderId = data.author?.member_openid?.trim();
    const groupId = data.group_openid?.trim();
    if (!senderId || !groupId) return null;
    return {
      eventId: messageId,
      messageId,
      conversationId: `group:${groupId}`,
      conversationLabel: `QQ群 ${groupId}`,
      senderId,
      text,
      target: { platform: "qq", kind: "group", id: groupId },
    };
  }

  if (type === "AT_MESSAGE_CREATE" || type === "DIRECT_MESSAGE_CREATE") {
    const senderId = data.author?.id?.trim();
    const channelId = data.channel_id?.trim();
    if (!senderId || !channelId) return null;
    return {
      eventId: messageId,
      messageId,
      conversationId: `channel:${channelId}`,
      conversationLabel: `QQ 频道 ${channelId}`,
      senderId,
      text,
      target: { platform: "qq", kind: "channel", id: channelId },
    };
  }

  return null;
}

export function createQQMarkdownMessage(
  target: Extract<ConnectorTarget, { platform: "qq" }>,
  content: string,
  msgSeq: number,
  replyToMessageId?: string,
) {
  const reply = replyToMessageId ? { msg_id: replyToMessageId } : {};
  return target.kind === "channel"
    ? { markdown: { content }, msg_type: 2, ...reply }
    : { markdown: { content }, msg_type: 2, msg_seq: msgSeq, ...reply };
}

export class QQConnectorClient implements ConnectorClient {
  private socket: WebSocket | null = null;
  private accessToken = "";
  private tokenExpiresAt = 0;
  private sequence: number | null = null;
  private sessionId = "";
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stopped = true;
  private connecting: Promise<void> | null = null;
  private lastHeartbeatAck = Date.now();

  constructor(
    private readonly config: ConnectorConfig,
    private readonly callbacks: ConnectorClientCallbacks,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly WebSocketImpl: typeof WebSocket = WebSocket,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    try {
      await this.connect();
    } catch (error) {
      this.callbacks.onStatus("error", errorMessage(error));
      this.scheduleReconnect(0);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close(1000, "connector stopped");
  }

  async send(target: ConnectorTarget, text: string, replyToMessageId?: string): Promise<void> {
    if (target.platform !== "qq") throw new Error("QQ 连接器收到不匹配的发送目标");
    const path =
      target.kind === "private"
        ? `/v2/users/${encodeURIComponent(target.id)}/messages`
        : target.kind === "group"
          ? `/v2/groups/${encodeURIComponent(target.id)}/messages`
          : `/channels/${encodeURIComponent(target.id)}/messages`;
    let msgSeq = Math.floor(Math.random() * 1_000_000) + 1;
    for (const content of chunks(text)) {
      const body = createQQMarkdownMessage(target, content, msgSeq++, replyToMessageId);
      await this.api(path, { method: "POST", body: JSON.stringify(body) });
    }
  }

  private async receiveMessage(type: string, data: QQMessageData): Promise<void> {
    const message = normalizeQQMessage(type, data);
    if (!message) return;

    const images = getQQImageAttachments(data);
    if (images.length === 0) {
      await this.callbacks.onMessage(message);
      return;
    }

    const ownerId = this.config.ownerId?.trim();
    if (!ownerId) throw new Error("QQ 连接器未配置所有者，无法保存图片");
    const attachments: Array<ReturnType<typeof storeUploadedImage>> = [];
    try {
      for (const image of images) {
        const downloaded = await fetchQQImage(image, this.fetchImpl);
        attachments.push(storeUploadedImage(
          ownerId,
          downloaded.buffer,
          downloaded.mimeType,
          downloaded.displayName,
        ));
      }
    } catch (error) {
      removeUploadedImages(ownerId, attachments);
      const failure = `图片接收失败：${errorMessage(error)}`;
      console.error(`[connector:${this.config.id}] QQ ${failure}`);
      await this.send(message.target, failure, message.messageId).catch((sendError) => {
        console.error(`[connector:${this.config.id}] QQ 图片错误消息回传失败`, sendError);
      });
      return;
    }

    await this.callbacks.onMessage({ ...message, attachments });
  }

  private async token(force = false): Promise<string> {
    if (!force && this.accessToken && Date.now() < this.tokenExpiresAt - 5 * 60_000) {
      return this.accessToken;
    }
    const response = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: this.config.appId, clientSecret: this.config.appSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json().catch(() => ({}))) as TokenResponse & { message?: string };
    if (!response.ok || !payload.access_token) {
      throw new Error(`QQ 鉴权失败 (HTTP ${response.status})${payload.message ? `: ${payload.message}` : ""}`);
    }
    const expiresIn = Number(payload.expires_in);
    this.accessToken = payload.access_token;
    this.tokenExpiresAt = Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 7_200) * 1_000;
    return this.accessToken;
  }

  private async api(path: string, init: RequestInit, retry = true): Promise<unknown> {
    const token = await this.token();
    const response = await this.fetchImpl(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        Authorization: `QQBot ${token}`,
        "X-Union-Appid": this.config.appId,
        ...init.headers,
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 && retry) {
      this.accessToken = "";
      await this.token(true);
      return this.api(path, init, false);
    }
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`QQ API 请求失败 (HTTP ${response.status})${body ? `: ${body.slice(0, 300)}` : ""}`);
    }
    return body ? JSON.parse(body) as unknown : undefined;
  }

  private async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    const connecting = this.openConnection();
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = null;
    }
  }

  private async openConnection(): Promise<void> {
    this.callbacks.onStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");
    const gateway = (await this.api("/gateway", { method: "GET" })) as { url?: string };
    if (!gateway.url) throw new Error("QQ Gateway 未返回连接地址");

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const socket = new this.WebSocketImpl(gateway.url!);
      this.socket = socket;
      const fail = (error: unknown) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.terminate();
          }
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const timeout = setTimeout(() => {
        socket.terminate();
        fail(new Error("QQ Gateway 连接超时"));
      }, 15_000);

      socket.on("message", (raw) => {
        let payload: GatewayPayload;
        try {
          payload = JSON.parse(raw.toString()) as GatewayPayload;
        } catch {
          return;
        }
        if (typeof payload.s === "number") this.sequence = payload.s;
        if (payload.op === 9) {
          this.sessionId = "";
          this.sequence = null;
          socket.close(4000, "gateway rejected session");
          return;
        }
        if (payload.op === 10) {
          const interval = (payload.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval;
          if (!interval) {
            fail(new Error("QQ Gateway 未返回心跳间隔"));
            return;
          }
          this.startHeartbeat(interval);
          void this.identify().catch(fail);
          return;
        }
        if (payload.op === 11) {
          this.lastHeartbeatAck = Date.now();
          return;
        }
        if (payload.op === 7) {
          socket.close(4000, "gateway requested reconnect");
          return;
        }
        if (payload.op !== 0 || !payload.t) return;
        if (payload.t === "READY" || payload.t === "RESUMED") {
          if (payload.t === "READY") {
            this.sessionId = (payload.d as { session_id?: string } | undefined)?.session_id ?? "";
          }
          if (!settled) {
            settled = true;
            clearTimeout(timeout);
            this.reconnectAttempt = 0;
            this.callbacks.onStatus("connected");
            resolve();
          }
          return;
        }
        void this.receiveMessage(payload.t, (payload.d ?? {}) as QQMessageData).catch((error) => {
          console.error(`[connector:${this.config.id}] QQ 消息处理失败`, error);
        });
      });
      socket.once("error", fail);
      socket.once("close", (code, reason) => {
        clearTimeout(timeout);
        if (this.socket === socket) this.socket = null;
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
        if (!settled) fail(new Error(`QQ Gateway 已断开 (${code} ${reason.toString()})`));
        if (!this.stopped) this.scheduleReconnect(code);
      });
    });
  }

  private async identify(): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("QQ Gateway 尚未连接");
    const token = await this.token();
    if (this.sessionId && this.sequence !== null) {
      socket.send(JSON.stringify({
        op: 6,
        d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.sequence },
      }));
      return;
    }
    socket.send(JSON.stringify({
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents: INTENTS,
        shard: [0, 1],
        properties: { $os: process.platform, $browser: "cloud-coding-agent", $device: "cloud-coding-agent" },
      },
    }));
  }

  private startHeartbeat(interval: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.lastHeartbeatAck = Date.now();
    const send = () => {
      const socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastHeartbeatAck > interval * 3) {
        socket.terminate();
        return;
      }
      socket.send(JSON.stringify({ op: 1, d: this.sequence }));
    };
    send();
    this.heartbeatTimer = setInterval(send, interval);
  }

  private scheduleReconnect(code: number): void {
    if (this.reconnectTimer || this.stopped) return;
    if ([4004, 4006, 4007].includes(code)) {
      this.accessToken = "";
      this.sessionId = "";
    } else if (code === 4009) {
      this.sessionId = "";
    }
    const base = [4004, 4006, 4007].includes(code)
      ? 5 * 60_000
      : RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)]!;
    const delay = Math.round(base * (0.7 + Math.random() * 0.6));
    this.reconnectAttempt += 1;
    this.callbacks.onStatus("reconnecting", `将在 ${Math.ceil(delay / 1_000)} 秒后重连`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch((error) => {
        this.callbacks.onStatus("error", errorMessage(error));
        this.scheduleReconnect(0);
      });
    }, delay);
  }
}
