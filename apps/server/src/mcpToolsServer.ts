// Agent 自定义工具的 MCP 桥（Streamable HTTP 传输）。
//
// DeepSeek Harness SDK 协议没有工具注册口，自定义工具（authenticated_git / browser_use /
// manage_skills / manage_mcp_servers）经 dsh-mcp-client 以 MCP 服务器形式接入运行时。
// 服务端自身就是这个 MCP 服务器：处理器留在进程内，保住每线程浏览器池、Git 凭据与 store 等共享状态。
//
// 实现 MCP Streamable HTTP 的最小面：initialize / tools/list / tools/call / ping，
// 请求为 JSON-RPC over HTTP POST，响应 application/json（规范允许 JSON 或 SSE 二选一）。
// 鉴权 = 进程级随机令牌（Authorization: Bearer）；线程选择 = x-cca-thread-id 请求头
// （每个会话的 dsh-mcp-client 行各带自己的线程头）。
import { randomUUID } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Tool, ToolResultObject } from "@cca/protocol";

export const AGENT_TOOLS_BRIDGE_TOKEN = randomUUID();
export const AGENT_TOOLS_SERVER_NAME = "cca-tools";
export const AGENT_TOOLS_MCP_PATH = "/api/agent-tools/mcp";

let baseUrl = "";

/** 服务端监听后回填基址（DSH 运行时以 streamable-http 连回来）。 */
export function setAgentToolsBaseUrl(url: string) {
  baseUrl = url.replace(/\/$/, "");
}

export function agentToolsMcpUrl(): string {
  return baseUrl ? baseUrl + AGENT_TOOLS_MCP_PATH : "";
}

const threadTools = new Map<string, Map<string, Tool>>();

export function registerThreadTools(threadId: string, tools: readonly Tool[]): void {
  const registry = new Map<string, Tool>();
  for (const tool of tools) registry.set(tool.name, tool);
  threadTools.set(threadId, registry);
}

export function unregisterThreadTools(threadId: string): void {
  threadTools.delete(threadId);
}

function toolsFor(request: FastifyRequest): Map<string, Tool> {
  const threadId = String(request.headers["x-cca-thread-id"] ?? "").trim();
  const registry = threadId ? threadTools.get(threadId) : undefined;
  if (!registry) throw new McpError(-32002, "未注册的会话工具集：" + (threadId || "(缺少 x-cca-thread-id)"));
  return registry;
}

class McpError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function inputSchemaOf(tool: Tool): Record<string, unknown> {
  const parameters = tool.parameters;
  if (!parameters) return { type: "object", properties: {} };
  const zodLike = parameters as { toJSONSchema?: () => Record<string, unknown> };
  if (typeof zodLike.toJSONSchema === "function") return zodLike.toJSONSchema();
  return parameters as Record<string, unknown>;
}

function toCallResult(value: unknown): { content: { type: "text"; text: string }[]; isError: boolean } {
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }], isError: false };
  }
  if (value && typeof value === "object" && "textResultForLlm" in value) {
    const result = value as ToolResultObject;
    return {
      content: [{ type: "text", text: result.textResultForLlm }],
      isError: result.resultType !== "success",
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(value ?? null) }], isError: false };
}

async function handleToolCall(request: FastifyRequest, params: Record<string, unknown>) {
  const registry = toolsFor(request);
  const name = String(params.name ?? "");
  const tool = registry.get(name);
  if (!tool) throw new McpError(-32602, "未知工具：" + name);
  if (!tool.handler) throw new McpError(-32602, "工具没有执行体：" + name);
  const threadId = String(request.headers["x-cca-thread-id"] ?? "").trim();
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  try {
    const result = await tool.handler(args, {
      sessionId: threadId,
      toolCallId: randomUUID(),
      toolName: name,
      arguments: args,
    });
    return toCallResult(result);
  } catch (error) {
    return {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

async function handleOne(message: JsonRpcMessage, request: FastifyRequest): Promise<object | undefined> {
  const id = message.id ?? null;
  const isNotification = message.id === undefined || message.method?.startsWith("notifications/");
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, error: string) => ({ jsonrpc: "2.0", id, error: { code, message: error } });

  if (isNotification) return undefined; // 通知（如 notifications/initialized）无需响应

  try {
    switch (message.method) {
      case "initialize": {
        const requested = (message.params?.protocolVersion as string | undefined) ?? "2025-06-18";
        return reply({
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: AGENT_TOOLS_SERVER_NAME, version: "0.1.0" },
        });
      }
      case "ping":
        return reply({});
      case "tools/list": {
        const tools = [...toolsFor(request).values()].map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: inputSchemaOf(tool),
        }));
        return reply({ tools });
      }
      case "tools/call":
        return reply(await handleToolCall(request, message.params ?? {}));
      default:
        return fail(-32601, "不支持的方法：" + (message.method ?? "(空)"));
    }
  } catch (error) {
    if (error instanceof McpError) return fail(error.code, error.message);
    return fail(-32603, error instanceof Error ? error.message : String(error));
  }
}

function authorized(request: FastifyRequest): boolean {
  const header = String(request.headers.authorization ?? "");
  const token = header.startsWith("Bearer ") ? header.slice(7) : String((request.query as { token?: string } | undefined)?.token ?? "");
  return token === AGENT_TOOLS_BRIDGE_TOKEN;
}

/** Fastify handler：POST 单条或批量 JSON-RPC；通知收到即 202。 */
export async function agentToolsMcpHandler(request: FastifyRequest, reply: FastifyReply) {
  if (!authorized(request)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const body = request.body;
  const messages: JsonRpcMessage[] = Array.isArray(body) ? (body as JsonRpcMessage[]) : [body as JsonRpcMessage];
  const responses: object[] = [];
  for (const message of messages) {
    const response = await handleOne(message, request);
    if (response) responses.push(response);
  }
  if (responses.length === 0) return reply.code(202).send();
  return reply
    .type("application/json")
    .send(Array.isArray(body) ? responses : responses[0]);
}
