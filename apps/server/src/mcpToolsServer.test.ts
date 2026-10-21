import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import type { Tool } from "@cca/protocol";
import {
  AGENT_TOOLS_BRIDGE_TOKEN,
  AGENT_TOOLS_MCP_PATH,
  agentToolsMcpHandler,
  agentToolsMcpUrl,
  registerThreadTools,
  setAgentToolsBaseUrl,
  unregisterThreadTools,
} from "./mcpToolsServer.js";

function buildApp() {
  const app = Fastify({ logger: false });
  app.post(AGENT_TOOLS_MCP_PATH, agentToolsMcpHandler);
  return app;
}

const tools: Tool[] = [
  {
    name: "echo_tool",
    description: "回显",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    handler: async (args) => "echo:" + String((args as { text?: string }).text ?? ""),
  },
  {
    name: "failing_tool",
    description: "总是失败",
    handler: () => {
      throw new Error("工具炸了");
    },
  },
  {
    name: "object_tool",
    description: "返回结构化结果",
    handler: () => ({ textResultForLlm: "结构化", resultType: "success" }),
  },
];

function post(app: ReturnType<typeof buildApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.inject({
    method: "POST",
    url: AGENT_TOOLS_MCP_PATH,
    headers: {
      authorization: "Bearer " + AGENT_TOOLS_BRIDGE_TOKEN,
      "x-cca-thread-id": "thread-1",
      ...headers,
    },
    payload: body as object,
  });
}

test("MCP bridge rejects unauthorized requests", async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  const response = await app.inject({
    method: "POST",
    url: AGENT_TOOLS_MCP_PATH,
    payload: { jsonrpc: "2.0", id: 1, method: "ping" },
  });
  assert.equal(response.statusCode, 401);
});

test("initialize, ping and notifications round-trip", async (t) => {
  const app = buildApp();
  t.after(() => app.close());

  const init = await post(app, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "dsh", version: "1" } },
  });
  assert.equal(init.statusCode, 200);
  const initBody = init.json();
  assert.equal(initBody.result.protocolVersion, "2025-06-18");
  assert.equal(initBody.result.serverInfo.name, "cca-tools");
  assert.deepEqual(initBody.result.capabilities, { tools: { listChanged: false } });

  const ping = await post(app, { jsonrpc: "2.0", id: 2, method: "ping" });
  assert.deepEqual(ping.json().result, {});

  const notification = await post(app, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(notification.statusCode, 202);
});

test("tools/list returns registered schemas only for the thread", async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  registerThreadTools("thread-1", tools);
  t.after(() => unregisterThreadTools("thread-1"));

  const listed = await post(app, { jsonrpc: "2.0", id: 3, method: "tools/list" });
  const body = listed.json();
  assert.deepEqual(
    body.result.tools.map((tool: { name: string }) => tool.name),
    ["echo_tool", "failing_tool", "object_tool"],
  );
  assert.deepEqual(body.result.tools[0].inputSchema, {
    type: "object",
    properties: { text: { type: "string" } },
  });
  // 未注册的线程拿到协议错误而不是空列表
  const unknown = await post(
    app,
    { jsonrpc: "2.0", id: 4, method: "tools/list" },
    { "x-cca-thread-id": "thread-x" },
  );
  assert.equal(unknown.json().error.code, -32002);
});

test("tools/call executes handlers and normalizes results", async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  registerThreadTools("thread-1", tools);
  t.after(() => unregisterThreadTools("thread-1"));

  const echo = await post(app, {
    jsonrpc: "2.0",
    id: 5,
    method: "tools/call",
    params: { name: "echo_tool", arguments: { text: "hi" } },
  });
  assert.deepEqual(echo.json().result, {
    content: [{ type: "text", text: "echo:hi" }],
    isError: false,
  });

  const objectResult = await post(app, {
    jsonrpc: "2.0",
    id: 6,
    method: "tools/call",
    params: { name: "object_tool", arguments: {} },
  });
  assert.deepEqual(objectResult.json().result, {
    content: [{ type: "text", text: "结构化" }],
    isError: false,
  });

  const failed = await post(app, {
    jsonrpc: "2.0",
    id: 7,
    method: "tools/call",
    params: { name: "failing_tool", arguments: {} },
  });
  assert.equal(failed.json().result.isError, true);
  assert.equal(failed.json().result.content[0].text, "工具炸了");

  const missing = await post(app, {
    jsonrpc: "2.0",
    id: 8,
    method: "tools/call",
    params: { name: "nope", arguments: {} },
  });
  assert.equal(missing.json().error.code, -32602);
});

test("unknown methods report JSON-RPC method-not-found", async (t) => {
  const app = buildApp();
  t.after(() => app.close());
  const response = await post(app, { jsonrpc: "2.0", id: 9, method: "resources/list" });
  assert.equal(response.json().error.code, -32601);
});

test("bridge url is only exposed after the server registers its base", () => {
  setAgentToolsBaseUrl("http://127.0.0.1:8787/");
  assert.equal(agentToolsMcpUrl(), "http://127.0.0.1:8787" + AGENT_TOOLS_MCP_PATH);
});
