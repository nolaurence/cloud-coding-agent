import * as lark from "@larksuiteoapi/node-sdk";
import type { ConnectorConfig } from "@cca/protocol";
import type {
  ConnectorClient,
  ConnectorClientCallbacks,
  ConnectorTarget,
  InboundConnectorMessage,
} from "./types.js";

interface FeishuMessageEvent {
  event_id?: string;
  sender: { sender_id?: { open_id?: string } };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
  };
}

function collectPostText(value: unknown, out: string[]): void {
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    for (const item of value) collectPostText(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") out.push(record.text);
  for (const child of Object.values(record)) collectPostText(child, out);
}

export function parseFeishuText(messageType: string, content: string): string | null {
  let payload: unknown;
  try {
    payload = JSON.parse(content) as unknown;
  } catch {
    return null;
  }
  if (messageType === "text") {
    const text = (payload as { text?: unknown }).text;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  }
  if (messageType === "post") {
    const parts: string[] = [];
    collectPostText(payload, parts);
    const text = parts.join("\n").trim();
    return text || null;
  }
  return null;
}

export function normalizeFeishuMessage(data: FeishuMessageEvent): InboundConnectorMessage | null {
  const senderId = data.sender.sender_id?.open_id?.trim();
  const messageId = data.message.message_id?.trim();
  const chatId = data.message.chat_id?.trim();
  const text = parseFeishuText(data.message.message_type, data.message.content);
  if (!senderId || !messageId || !chatId || !text) return null;
  return {
    eventId: data.event_id?.trim() || messageId,
    messageId,
    conversationId: `chat:${chatId}`,
    conversationLabel: `飞书${data.message.chat_type === "p2p" ? "私聊" : "群聊"} ${chatId}`,
    senderId,
    text,
    target: { platform: "feishu", kind: "chat", id: chatId },
  };
}

function chunks(text: string, size = 4_000): string[] {
  const out: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) out.push(text.slice(offset, offset + size));
  return out.length > 0 ? out : [""];
}

export class FeishuConnectorClient implements ConnectorClient {
  private readonly client: lark.Client;
  private wsClient: lark.WSClient | null = null;

  constructor(
    private readonly config: ConnectorConfig,
    private readonly callbacks: ConnectorClientCallbacks,
  ) {
    this.client = new lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      disableTokenCache: false,
      loggerLevel: lark.LoggerLevel.warn,
    });
  }

  async start(): Promise<void> {
    this.callbacks.onStatus("connecting");
    const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.warn }).register({
      "im.message.receive_v1": async (data) => {
        const message = normalizeFeishuMessage(data);
        if (!message) return;
        void this.callbacks.onMessage(message).catch((error) => {
          console.error(`[connector:${this.config.id}] 飞书消息处理失败`, error);
        });
      },
    });
    const wsClient = new lark.WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      loggerLevel: lark.LoggerLevel.warn,
      autoReconnect: true,
      handshakeTimeoutMs: 15_000,
      wsConfig: { pingTimeout: 10 },
      onReady: () => this.callbacks.onStatus("connected"),
      onReconnecting: () => this.callbacks.onStatus("reconnecting"),
      onReconnected: () => this.callbacks.onStatus("connected"),
      onError: (error) => this.callbacks.onStatus("error", error.message),
    });
    this.wsClient = wsClient;
    await wsClient.start({ eventDispatcher: dispatcher });
  }

  async stop(): Promise<void> {
    this.wsClient?.close({ force: true });
    this.wsClient = null;
  }

  async send(target: ConnectorTarget, text: string): Promise<void> {
    if (target.platform !== "feishu") throw new Error("飞书连接器收到不匹配的发送目标");
    for (const part of chunks(text)) {
      const response = await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: target.id,
          msg_type: "text",
          content: JSON.stringify({ text: part }),
        },
      });
      if (response.code && response.code !== 0) {
        throw new Error(`飞书发送失败 (${response.code}): ${response.msg ?? "未知错误"}`);
      }
    }
  }
}
