// DeepSeek Harness 会话事件 → 应用 SessionEvent 契约的映射层（纯逻辑，可单测）。
// DSH 的会话日志是事实来源（"模型可见即日志可重建"），这里把它投影成
// apps/server 既有消费方（copilot.ts 的 handleSessionEvent / rebuildHistory）认识的 17 种事件。
import type {
  AssistantMessageData,
  SessionEvent,
  SessionEventData,
  ToolExecutionCompleteData,
  ToolExecutionStartData,
} from "@cca/protocol";
import type {
  DshContentBlock,
  DshMessageSource,
  DshSessionEvent,
  DshStreamChunk,
  DshTokenUsage,
  HarnessNotificationMethod,
  SessionEventNotification,
  SessionStatusNotification,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from "./dshWire.js";

/** MCP 工具在 DSH 里的公开名：`mcp__<serverName>__<rawName>`。 */
const MCP_TOOL_NAME = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/;

export function textOfContent(blocks: readonly DshContentBlock[] | undefined): string {
  if (!blocks) return "";
  return blocks
    .map((block) => (block.type === "text" ? (block as { text?: string }).text ?? "" : ""))
    .filter(Boolean)
    .join("");
}

export function reasoningOfContent(blocks: readonly DshContentBlock[] | undefined): string {
  if (!blocks) return "";
  return blocks
    .map((block) => (block.type === "reasoning" ? (block as { text?: string }).text ?? "" : ""))
    .filter(Boolean)
    .join("");
}

function sourceText(source: DshMessageSource | undefined): string | undefined {
  if (!source) return undefined;
  if (source.kind === "user") return undefined;
  if (source.kind === "plugin") return `skill:${source.plugin ?? "plugin"}`;
  return String(source.kind);
}

function toolNames(name: string): Pick<ToolExecutionStartData, "toolName" | "mcpServerName" | "mcpToolName"> {
  const matched = MCP_TOOL_NAME.exec(name);
  if (matched) return { toolName: name, mcpServerName: matched[1], mcpToolName: matched[2] };
  return { toolName: name };
}

function isoTime(time: number): string {
  return new Date(time > 0 ? time : Date.now()).toISOString();
}

export interface DshEventMapperOptions {
  rootSessionId: string;
  /** 上下文窗口（token）；已知时用 DSH 的 usage 投影 session.usage_info。 */
  contextWindowTokens?: number;
  /** 生成事件 id；默认用确定性 id（同一会话日志重放保持稳定，便于事件存储幂等）。 */
  makeId?: (event: DshSessionEvent | { type: string }) => string;
}

interface SynthesizedInput {
  type: string;
  data: Record<string, unknown>;
  agentId?: string;
  timestamp?: string;
  id?: string;
}

/**
 * 有状态映射器：把 SDK 协议通知流投影成应用 SessionEvent。
 * 状态只用于合成事件（session.idle / subagent 生命周期）的序号，不缓存会话内容。
 */
export class DshEventMapper {
  private readonly rootSessionId: string;
  private readonly contextWindowTokens: number | undefined;
  private readonly makeId: (event: DshSessionEvent | { type: string }) => string;
  private syntheticSeq = 0;

  constructor(options: DshEventMapperOptions) {
    this.rootSessionId = options.rootSessionId;
    this.contextWindowTokens = options.contextWindowTokens;
    this.makeId = options.makeId ?? ((event) => `${options.rootSessionId}-${event.type}-${"seq" in event ? event.seq : (this.syntheticSeq += 1)}`);
  }

  /** `session.event` 通知：一条 DSH 会话日志事件 → 0..n 条应用事件。 */
  mapSessionEvent(notification: SessionEventNotification): SessionEvent[] {
    const { sessionId, event } = notification;
    const agentId = sessionId === this.rootSessionId ? undefined : sessionId;
    const out: SessionEvent[] = [];
    const push = <K extends SessionEvent["type"]>(
      type: K,
      data: SessionEventData<K>,
      timestamp = isoTime(event.time),
    ) => {
      out.push({
        id: this.makeId({ ...event, type }),
        parentId: null,
        timestamp,
        type,
        data,
        ...(agentId ? { agentId } : {}),
      } as SessionEvent);
    };

    switch (event.type) {
      case "turn/start":
        push("assistant.turn_start", { turnId: `turn-${event.data.turn}` });
        break;
      case "turn/end": {
        push("assistant.turn_end", {});
        const reason = event.data.reason;
        if (reason?.kind === "aborted") {
          push("abort", { reason: typeof reason.reason === "string" ? reason.reason : reason.reason?.kind });
        }
        break;
      }
      case "user/message":
        push("user.message", {
          content: textOfContent(event.data.content),
          source: sourceText(event.data.source),
        });
        break;
      case "assistant/chunk": {
        const chunk = event.data.chunk;
        const messageId = `step-${event.data.turn}-${event.data.step}`;
        if (chunk.type === "text-delta") {
          push("assistant.message_delta", { messageId, deltaContent: chunk.text });
        } else if (chunk.type === "reasoning-delta") {
          push("assistant.reasoning_delta", {
            reasoningId: `${messageId}-reasoning`,
            deltaContent: chunk.text,
          });
        }
        break;
      }
      case "assistant/message": {
        const message = event.data.message;
        const content = textOfContent(message.content);
        const reasoningText = reasoningOfContent(message.content);
        const data: AssistantMessageData = {
          messageId: message.id,
          content,
          ...(reasoningText ? { reasoningText } : {}),
          turnId: `turn-${event.data.turn}`,
        };
        push("assistant.message", data);
        if (event.data.usage && this.contextWindowTokens) {
          push("session.usage_info", {
            currentTokens: event.data.usage.inputTokens + event.data.usage.outputTokens,
            tokenLimit: this.contextWindowTokens,
          });
        }
        break;
      }
      case "tool/call": {
        const data: ToolExecutionStartData = {
          toolCallId: event.data.callId,
          ...toolNames(event.data.name),
          arguments: parseArguments(event.data.arguments),
        };
        push("tool.execution_start", data);
        break;
      }
      case "tool/result": {
        const block = event.data.message.content[0];
        const callId = block?.toolCallId ?? event.data.message.source.callId;
        const isError = Boolean(block?.isError || event.data.error);
        const data: ToolExecutionCompleteData = {
          toolCallId: callId,
          success: !isError,
          result: {
            content: textOfContent(block?.content),
            detailedContent: textOfContent(block?.content),
          },
          ...(event.data.error
            ? { error: { message: `${event.data.error.name}: ${event.data.error.code}` } }
            : isError
              ? { error: { message: "工具执行失败" } }
              : {}),
        };
        push("tool.execution_complete", data);
        break;
      }
      default:
        // step/*、request/*、todo/write、session/end-seed 与插件扩展事件不进应用契约。
        break;
    }
    return out;
  }

  /** `session.status` 通知：整 agent 空闲是应用层权威的回合结束信号。 */
  mapStatus(notification: SessionStatusNotification): SessionEvent[] {
    if (notification.status !== "idle") return [];
    return [this.synthetic("session.idle", { aborted: false })];
  }

  /** `subagent.started` 通知：DSH 内部子会话诞生。 */
  mapSubagentStarted(notification: SubagentStartedNotification): SessionEvent[] {
    return [
      this.synthetic("subagent.started", {
        toolCallId: notification.childSessionId,
        agentName: notification.childSessionId,
        agentDisplayName: notification.childSessionId,
        agentDescription: "DeepSeek Harness 子代理",
      }),
    ];
  }

  /** `subagent.finished` 通知：子代理收尾。 */
  mapSubagentFinished(notification: SubagentFinishedNotification): SessionEvent[] {
    const base = {
      toolCallId: notification.childSessionId,
      agentName: notification.agentId || notification.childSessionId,
      agentDisplayName: notification.agentId || notification.childSessionId,
      agentDescription: "DeepSeek Harness 子代理",
    };
    if (notification.status === "ok") {
      return [this.synthetic("subagent.completed", { ...base })];
    }
    return [
      this.synthetic("subagent.failed", {
        ...base,
        error: `子代理结束：${notification.stopReason}`,
      }),
    ];
  }

  /** 运行时消亡（传输丢失/被终止）：收尾事件序列。 */
  mapTransportClosed(reason: string): SessionEvent[] {
    return [
      this.synthetic("session.error", { message: reason, errorType: "transport" }),
      this.synthetic("abort", { reason }),
      this.synthetic("session.shutdown", {}),
    ];
  }

  /** 用户中断：只发 abort（会话对象保持可用，运行时可再拉起）。 */
  mapAborted(reason: string): SessionEvent[] {
    return [this.synthetic("abort", { reason })];
  }

  /** 通用通知入口：按方法名分派；未知方法返回空数组（向前兼容）。 */
  mapNotification(method: HarnessNotificationMethod | string, params: Record<string, unknown>): SessionEvent[] {
    switch (method) {
      case "session.event":
        return this.mapSessionEvent(params as unknown as SessionEventNotification);
      case "session.status":
        return this.mapStatus(params as unknown as SessionStatusNotification);
      case "subagent.started":
        return this.mapSubagentStarted(params as unknown as SubagentStartedNotification);
      case "subagent.finished":
        return this.mapSubagentFinished(params as unknown as SubagentFinishedNotification);
      default:
        return [];
    }
  }

  private synthetic<K extends SessionEvent["type"]>(type: K, data: SessionEventData<K>): SessionEvent {
    this.syntheticSeq += 1;
    return {
      id: this.makeId({ type: `synthetic:${this.syntheticSeq}` }),
      parentId: null,
      timestamp: new Date().toISOString(),
      type,
      data,
    } as SessionEvent;
  }
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** 一次性文本生成的输出块拼接（generateText 用）。 */
export function concatText(blocks: readonly DshContentBlock[]): string {
  return textOfContent(blocks);
}

export type { DshStreamChunk, DshTokenUsage };
