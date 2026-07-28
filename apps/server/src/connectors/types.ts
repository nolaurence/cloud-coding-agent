import type {
  ConnectorConfig,
  ConnectorConnectionState,
} from "@cca/protocol";

export type ConnectorTarget =
  | { platform: "qq"; kind: "private" | "group" | "channel"; id: string }
  | { platform: "feishu"; kind: "chat"; id: string };

export interface InboundConnectorMessage {
  eventId: string;
  messageId: string;
  conversationId: string;
  conversationLabel: string;
  senderId: string;
  text: string;
  target: ConnectorTarget;
}

export interface ConnectorClientCallbacks {
  onMessage: (message: InboundConnectorMessage) => Promise<void>;
  onStatus: (state: ConnectorConnectionState, message?: string) => void;
}

export interface ConnectorClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(target: ConnectorTarget, text: string, replyToMessageId?: string): Promise<void>;
}

export type ConnectorClientFactory = (
  config: ConnectorConfig,
  callbacks: ConnectorClientCallbacks,
) => ConnectorClient;
