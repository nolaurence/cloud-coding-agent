// DeepSeek Harness 会话事件 → 应用 SessionEvent 契约的映射层（纯逻辑，可单测）。
//
// DSH 的会话日志是事实来源；这里把它投影成 apps/server 既有消费方
// （copilot.ts 的 handleSessionEvent / rebuildHistory）认识的事件形状。
// 只映射应用消费的事件；inbox/step/request/system 等纯日志事件忽略。
import { randomUUID } from "node:crypto";
import { isAttachmentReferenceText } from "../attachmentPrompt.js";
import type { SessionEvent } from "@github/copilot-sdk";
import type {
  DshAssistantChunkData,
  DshAssistantMessageData,
  DshContentBlock,
  DshMessage,
  DshMessageSource,
  DshToolCallData,
  DshToolResultData,
  DshTokenUsage,
  DshTurnEndData,
  DshTurnStartData,
  DshUserMessageData,
  SessionEventNotification,
  SessionStatusNotification,
  SubagentFinishedNotification,
  SubagentStartedNotification,
} from "./dshWire.js";

type SessionEventType = SessionEvent["type"];
type SessionEventData<K extends SessionEventType> = Extract<SessionEvent, { type: K }>["data"];

/** MCP 工具在 DSH 里的公开名：`mcp__<serverName>__<rawName>`。 */
const MCP_TOOL_NAME = /^mcp__([A-Za-z0-9_-]{1,32})__(.+)$/;

export function textOfContent(blocks: readonly DshContentBlock[] | undefined): string {
  if (!blocks) return "";
  return blocks
    .map((block) => (block.type === "text" ? block.text ?? "" : ""))
    .filter(Boolean)
    .join("");
}

export function reasoningOfContent(blocks: readonly DshContentBlock[] | undefined): string {
  if (!blocks) return "";
  return blocks
    .map((block) => (block.type === "reasoning" ? block.text ?? "" : ""))
    .filter(Boolean)
    .join("");
}

function toolNames(name: string): { toolName: string; mcpServerName?: string; mcpToolName?: string } {
  const matched = MCP_TOOL_NAME.exec(name);
  if (matched) return { toolName: name, mcpServerName: matched[1], mcpToolName: matched[2] };
  return { toolName: name };
}

function isoTime(time: number): string {
  return new Date(time > 0 ? time : Date.now()).toISOString();
}

function parseArguments(raw: string): Record<string, unknown> | string {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : raw;
  } catch {
    return raw;
  }
}

function isHumanMessage(source: DshMessageSource | undefined): boolean {
  return source?.kind === "user";
}

export interface DshEventMapperOptions {
  rootSessionId: string;
  /** 上下文窗口（token）；已知时用 DSH 的 usage 投影 session.usage_info。 */
  contextWindowTokens?: number;
  /** 生成事件 id；默认按 (sessionId, type, seq) 确定性生成，合成事件使用随机 id。 */
  makeId?: (event: { type: string; sessionId?: string; seq?: number }) => string;
}

/**
 * 有状态映射器：把 SDK 协议通知流投影成应用 SessionEvent。
 * 状态只用于合成事件 id，不缓存会话内容。
 */
export class DshEventMapper {
  private readonly rootSessionId: string;
  private contextWindowTokens: number | undefined;
  private readonly makeId: (event: { type: string; sessionId?: string; seq?: number }) => string;

  constructor(options: DshEventMapperOptions) {
    this.rootSessionId = options.rootSessionId;
    this.contextWindowTokens = options.contextWindowTokens;
    this.makeId = options.makeId ?? ((event) =>
      event.sessionId !== undefined && event.seq !== undefined
        ? `${event.sessionId}-${event.type}-${event.seq}`
        : `${this.rootSessionId}-${event.type}-${randomUUID()}`);
  }

  /** 会话内切换模型后更新上下文窗口，后续 usage 事件按新窗口投影。 */
  setContextWindowTokens(value: number | undefined) {
    this.contextWindowTokens = value;
  }

  /** `session.event` 通知：一条 DSH 会话日志事件 → 0..n 条应用事件。 */
  mapSessionEvent(notification: SessionEventNotification): SessionEvent[] {
    const { sessionId, event } = notification;
    const agentId = sessionId === this.rootSessionId ? undefined : sessionId;
    const out: SessionEvent[] = [];
    const push = <K extends SessionEventType>(
      type: K,
      data: SessionEventData<K>,
    ) => {
      out.push({
        id: this.makeId({ type, sessionId, seq: event.seq }),
        parentId: null,
        timestamp: isoTime(event.time),
        type,
        data,
        ...(agentId ? { agentId } : {}),
      } as SessionEvent);
    };

    switch (event.type) {
      case "turn/start": {
        const data = event.data as DshTurnStartData;
        push("assistant.turn_start", { turnId: `turn-${data.turn}` });
        break;
      }
      case "turn/end": {
        const data = event.data as DshTurnEndData;
        push("assistant.turn_end", {});
        if (data.reason?.kind === "aborted") {
          push("abort", {
            reason: typeof data.reason.reason === "string" ? data.reason.reason : data.reason.reason?.kind,
          });
        } else if (data.reason?.kind === "error") {
          push("session.error", {
            message: data.reason.error?.message ?? "DeepSeek Harness 回合失败",
            errorType: "harness",
          });
        }
        break;
      }
      case "user/message": {
        const data = event.data as DshUserMessageData;
        const message = data.message ?? (data as DshMessage);
        // agent-instructions / runtime-context / skill 注入不是用户可见消息。
        if (!message?.content || !isHumanMessage(message.source)) break;
        const visibleContent = message.content.filter((block, index) => index === 0 ||
          block.type !== "text" || !isAttachmentReferenceText(block.text ?? ""));
        push("user.message", { content: textOfContent(visibleContent), source: undefined });
        break;
      }
      case "assistant/chunk": {
        const data = event.data as DshAssistantChunkData;
        const chunk = data.chunk;
        const messageId = `step-${data.turn}-${data.step}`;
        if (chunk?.type === "text-delta") {
          push("assistant.message_delta", { messageId, deltaContent: chunk.text });
        } else if (chunk?.type === "reasoning-delta") {
          push("assistant.reasoning_delta", {
            reasoningId: `${messageId}-reasoning`,
            deltaContent: chunk.text,
          });
        }
        break;
      }
      case "assistant/message": {
        const data = event.data as DshAssistantMessageData;
        const message = data.message;
        if (!message) break;
        const content = textOfContent(message.content);
        const reasoningText = reasoningOfContent(message.content);
        // 同一步的流式增量与最终消息共用确定性 id，避免历史重建时重复。
        const messageId = `step-${data.turn}-${data.step}`;
        const turnId = `turn-${data.turn}`;
        if (content || reasoningText) {
          push("assistant.message", {
            messageId,
            content,
            ...(reasoningText ? { reasoningText } : {}),
            turnId,
          });
        }
        const usage = data.usage;
        if (usage && this.contextWindowTokens) {
          // DSH 的 inputTokens 只含未命中缓存的输入；上下文用量应包含缓存读/写。
          const total = usage.totalTokens;
          const currentTokens =
            typeof total === "number" && Number.isFinite(total) && total >= 0
              ? total
              : usage.inputTokens +
                (usage.cacheReadTokens ?? 0) +
                (usage.cacheWriteTokens ?? 0) +
                usage.outputTokens;
          push("session.usage_info", {
            currentTokens,
            tokenLimit: this.contextWindowTokens,
          });
        }
        break;
      }
      case "tool/call": {
        const data = event.data as DshToolCallData;
        push("tool.execution_start", {
          toolCallId: data.callId,
          ...toolNames(data.name),
          arguments: parseArguments(data.arguments) as SessionEventData<"tool.execution_start">["arguments"],
        });
        break;
      }
      case "tool/result": {
        const data = event.data as DshToolResultData;
        const message = data.message;
        const block = message?.content?.find((candidate) => candidate.type === "tool-result");
        const callId = message?.toolCallId ?? message?.source?.callId ?? block?.toolCallId;
        if (!callId) break;
        const isError = Boolean(message?.isError || data.error);
        // 0.2.1-rc.2 的 tool/result 直接把文本块放在 message.content；
        // 旧格式把 tool-result 块包在 content 里，两种都支持。
        const text = block?.type === "tool-result"
          ? textOfContent(block.content)
          : textOfContent(message?.content);
        push("tool.execution_complete", {
          toolCallId: callId,
          success: !isError,
          result: { content: text, detailedContent: text },
          ...(isError
            ? {
                error: {
                  message: data.error
                    ? `${data.error.name}: ${data.error.code}`
                    : text || "工具执行失败",
                },
              }
            : {}),
        });
        break;
      }
      case "todo/write": {
        const toolCallId = `${sessionId}:todo:${event.seq}`;
        const data = event.data as { todos?: unknown };
        push("tool.execution_start", { toolCallId, toolName: "todo_write", arguments: { todos: data.todos } });
        push("tool.execution_complete", { toolCallId, success: true, result: { content: "计划已更新" } });
        break;
      }
      default:
        break;
    }
    return out;
  }

  /** `session.status` 通知：只有根会话整 agent 空闲才是应用层权威的回合结束信号。 */
  mapStatus(notification: SessionStatusNotification): SessionEvent[] {
    if (notification.sessionId !== this.rootSessionId) return [];
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
      }, notification.childSessionId),
    ];
  }

  /** `subagent.finished` 通知：子代理收尾。 */
  mapSubagentFinished(notification: SubagentFinishedNotification): SessionEvent[] {
    const base = {
      toolCallId: notification.childSessionId,
      agentName: notification.agentId || notification.childSessionId,
      agentDisplayName: notification.agentId || notification.childSessionId,
    };
    if (notification.status === "ok") {
      return [
        this.synthetic("subagent.completed", {
          ...base,
          agentDescription: "DeepSeek Harness 子代理",
        }, notification.childSessionId),
      ];
    }
    return [
      this.synthetic("subagent.failed", {
        ...base,
        agentDescription: "DeepSeek Harness 子代理",
        error: `子代理结束：${notification.stopReason}`,
      }, notification.childSessionId),
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
  mapNotification(method: string, params: Record<string, unknown>): SessionEvent[] {
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

  private synthetic<K extends SessionEventType>(
    type: K,
    data: SessionEventData<K>,
    agentId?: string,
  ): SessionEvent {
    return {
      id: this.makeId({ type }),
      parentId: null,
      timestamp: new Date().toISOString(),
      type,
      data,
      ...(agentId ? { agentId } : {}),
    } as SessionEvent;
  }
}

