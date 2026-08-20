import { randomUUID } from "node:crypto";
import type {
  ConnectorConfig,
  ConnectorConnectionState,
  ConnectorStatus,
  ModelRef,
  ThreadEvent,
  ThreadMeta,
} from "@cca/protocol";
import type { CopilotManager } from "../copilot.js";
import { store } from "../store.js";
import { FeishuConnectorClient } from "./feishu.js";
import { QQConnectorClient } from "./qq.js";
import type {
  ConnectorClient,
  ConnectorClientFactory,
  InboundConnectorMessage,
} from "./types.js";

const EVENT_TTL_MS = 10 * 60_000;
const TURN_TIMEOUT_MS = 60 * 60_000;

interface RunningConnector {
  config: ConnectorConfig;
  client: ConnectorClient;
}

interface TurnOutcome {
  text?: string;
  error?: string;
}

interface TurnWaiter {
  subscribed: boolean;
  messages: string[];
  resolve: (outcome: TurnOutcome) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_FACTORIES: Record<ConnectorConfig["platform"], ConnectorClientFactory> = {
  qq: (config, callbacks) => new QQConnectorClient(config, callbacks),
  feishu: (config, callbacks) => new FeishuConnectorClient(config, callbacks),
};

function modelKey(model: ModelRef): string {
  return `${model.providerId}\u0000${model.modelId}\u0000${model.reasoningEffort ?? ""}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ConnectorManager {
  private readonly running = new Map<string, RunningConnector>();
  private readonly statuses = new Map<string, ConnectorStatus>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly seenEvents = new Map<string, number>();
  private readonly turnWaiters = new Map<string, TurnWaiter>();
  private readonly removeThreadEventSink: () => unknown;
  private configs: ConnectorConfig[] = [];

  constructor(
    private readonly manager: CopilotManager,
    private readonly onStatusesChanged: (statuses: ConnectorStatus[]) => void,
    private readonly onThreadsChanged: () => void,
    private readonly factories = DEFAULT_FACTORIES,
  ) {
    const removeSink = this.manager.onThreadEvent((threadId, event) => this.onThreadEvent(threadId, event));
    this.removeThreadEventSink = typeof removeSink === "function" ? removeSink : () => {};
  }

  getStatuses(): ConnectorStatus[] {
    return this.configs.map((config) =>
      this.statuses.get(config.id) ?? {
        id: config.id,
        state: config.enabled ? "connecting" : "disabled",
        updatedAt: Date.now(),
      },
    );
  }

  async applySettings(configs: ConnectorConfig[]): Promise<void> {
    const nextConfigs = configs.map((config) => ({
      ...config,
      model: { ...config.model },
      allowedUserIds: config.allowedUserIds ? [...config.allowedUserIds] : undefined,
    }));
    for (const config of nextConfigs) {
      if (!config.enabled) continue;
      const project = store.projects.find((candidate) => candidate.id === config.projectId);
      if (!config.ownerId || !project || project.ownerId !== config.ownerId) {
        throw new Error(config.name + " 关联的工作区与所有者不匹配");
      }
    }
    this.configs = nextConfigs;
    const nextById = new Map(this.configs.map((config) => [config.id, config]));

    const clientsToStop: Array<{ id: string; client: ConnectorClient }> = [];
    for (const [id, current] of [...this.running]) {
      const next = nextById.get(id);
      if (next?.enabled && JSON.stringify(next) === JSON.stringify(current.config)) continue;
      if (next?.enabled) this.startConnector(next);
      else this.running.delete(id);
      clientsToStop.push({ id, client: current.client });
    }

    await Promise.all(clientsToStop.map(async ({ id, client }) => {
      await client.stop().catch((error) => {
        console.error(`[connector:${id}] 停止失败`, error);
      });
    }));

    for (const config of this.configs) {
      if (!config.enabled) {
        this.setStatus(config.id, "disabled");
        continue;
      }
      if (this.running.has(config.id)) continue;
      this.startConnector(config);
    }

    for (const id of [...this.statuses.keys()]) {
      if (!nextById.has(id)) this.statuses.delete(id);
    }
    this.emitStatuses();
  }

  async shutdown(): Promise<void> {
    this.removeThreadEventSink();
    const clients = [...this.running.values()].map(({ client }) => client);
    this.running.clear();
    for (const waiter of this.turnWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.resolve({ error: "连接器服务正在关闭" });
    }
    this.turnWaiters.clear();
    await Promise.allSettled(clients.map((client) => client.stop()));
  }

  private startConnector(config: ConnectorConfig): void {
    let client: ConnectorClient | undefined;
    const callbacks = {
      onMessage: (message: InboundConnectorMessage) => {
        if (!client || this.running.get(config.id)?.client !== client) return Promise.resolve();
        return this.handleInbound(config.id, message);
      },
      onStatus: (state: ConnectorConnectionState, message?: string) => {
        if (client && this.running.get(config.id)?.client === client) {
          this.setStatus(config.id, state, message);
        }
      },
    };
    client = this.factories[config.platform](config, callbacks);
    this.running.set(config.id, { config, client });
    this.setStatus(config.id, "connecting");
    void client.start().catch((error) => {
      if (this.running.get(config.id)?.client !== client) return;
      this.setStatus(config.id, "error", errorMessage(error));
      console.error(`[connector:${config.id}] 启动失败`, error);
    });
  }

  private setStatus(id: string, state: ConnectorConnectionState, message?: string): void {
    const current = this.statuses.get(id);
    if (current?.state === state && current.message === message) return;
    this.statuses.set(id, { id, state, message, updatedAt: Date.now() });
    this.emitStatuses();
  }

  private emitStatuses(): void {
    this.onStatusesChanged(this.getStatuses());
  }

  private async handleInbound(connectorId: string, message: InboundConnectorMessage): Promise<void> {
    const current = this.running.get(connectorId);
    if (!current || current.config.platform !== message.target.platform) return;
    if (
      current.config.allowedUserIds?.length &&
      !current.config.allowedUserIds.includes(message.senderId)
    ) {
      return;
    }
    if (this.isDuplicate(connectorId, message.eventId)) return;

    const queueKey = `${connectorId}\u0000${message.conversationId}`;
    const previous = this.queues.get(queueKey) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => this.processMessage(connectorId, message));
    this.queues.set(queueKey, task);
    try {
      await task;
    } finally {
      if (this.queues.get(queueKey) === task) this.queues.delete(queueKey);
    }
  }

  private isDuplicate(connectorId: string, eventId: string): boolean {
    const now = Date.now();
    for (const [key, seenAt] of this.seenEvents) {
      if (now - seenAt > EVENT_TTL_MS) this.seenEvents.delete(key);
    }
    const key = `${connectorId}\u0000${eventId}`;
    if (this.seenEvents.has(key)) return true;
    this.seenEvents.set(key, now);
    return false;
  }

  private async processMessage(
    connectorId: string,
    message: InboundConnectorMessage,
  ): Promise<void> {
    const current = this.running.get(connectorId);
    if (!current || current.config.platform !== message.target.platform) return;
    try {
      const thread = this.findOrCreateThread(current.config, message);
      const outcomePromise = this.waitForTurn(thread.id);
      try {
        await this.manager.subscribe(
          thread.id,
          current.config.ownerId ?? thread.userId ?? "",
        );
        const waiter = this.turnWaiters.get(thread.id);
        if (waiter) waiter.subscribed = true;
        await this.manager.sendMessage(
          thread.id,
          message.text,
          undefined,
          current.config.ownerId ?? thread.userId ?? "",
        );
      } catch (error) {
        this.finishWaiter(thread.id, { error: errorMessage(error) });
      }
      const outcome = await outcomePromise;
      if (outcome.error) throw new Error(outcome.error);
      if (!outcome.text) throw new Error("Agent 未返回文本消息");
      const replyClient = this.compatibleClient(current.config.id, message.target.platform);
      if (!replyClient) throw new Error("连接器已停用或平台配置已变更");
      await replyClient.send(message.target, outcome.text, message.messageId);
    } catch (error) {
      const failure = `处理消息失败：${errorMessage(error)}`;
      console.error(`[connector:${current.config.id}] ${failure}`);
      const replyClient = this.compatibleClient(current.config.id, message.target.platform);
      if (!replyClient) return;
      await replyClient.send(message.target, failure, message.messageId).catch((sendError) => {
        console.error(`[connector:${current.config.id}] 错误消息回传失败`, sendError);
      });
    }
  }

  private compatibleClient(
    connectorId: string,
    platform: ConnectorConfig["platform"],
  ): ConnectorClient | undefined {
    const current = this.running.get(connectorId);
    return current?.config.platform === platform ? current.client : undefined;
  }

  private findOrCreateThread(
    config: ConnectorConfig,
    message: InboundConnectorMessage,
  ): ThreadMeta {
    const existing = store.threads.find(
      (thread) =>
        !thread.archived &&
        thread.connector?.connectorId === config.id &&
        thread.connector.conversationId === message.conversationId &&
        thread.projectId === config.projectId &&
        thread.model !== undefined &&
        modelKey(thread.model) === modelKey(config.model),
    );
    if (existing) return existing;

    const now = Date.now();
    const thread: ThreadMeta = {
      id: randomUUID(),
      projectId: config.projectId,
      title: `${config.name} · ${message.conversationLabel}`.slice(0, 80),
      model: { ...config.model },
      modelProviderId: config.model.providerId,
      userId: config.ownerId,
      createdAt: now,
      updatedAt: now,
      archived: false,
      connector: {
        connectorId: config.id,
        platform: config.platform,
        conversationId: message.conversationId,
      },
    };
    store.upsertThread(thread);
    this.onThreadsChanged();
    return thread;
  }

  private waitForTurn(threadId: string): Promise<TurnOutcome> {
    if (this.turnWaiters.has(threadId)) {
      return Promise.resolve({ error: "当前外部会话仍有任务运行" });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.finishWaiter(threadId, { error: "Agent 响应超时" });
      }, TURN_TIMEOUT_MS);
      this.turnWaiters.set(threadId, { subscribed: false, messages: [], resolve, timer });
    });
  }

  private finishWaiter(threadId: string, outcome: TurnOutcome): void {
    const waiter = this.turnWaiters.get(threadId);
    if (!waiter) return;
    this.turnWaiters.delete(threadId);
    clearTimeout(waiter.timer);
    if (waiter.subscribed) this.manager.unsubscribe(threadId);
    waiter.resolve(outcome);
  }

  private onThreadEvent(threadId: string, event: ThreadEvent): void {
    const waiter = this.turnWaiters.get(threadId);
    if (!waiter) return;
    if (event.kind === "assistant.message" && event.message.text.trim()) {
      waiter.messages.push(event.message.text.trim());
    } else if (event.kind === "error") {
      this.finishWaiter(threadId, { error: event.message });
    } else if (event.kind === "turn.end") {
      this.finishWaiter(threadId, { text: waiter.messages.join("\n\n").trim() });
    }
  }
}
