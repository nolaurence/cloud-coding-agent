import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { responsesToChat, chatToResponses, sseData, startLlmGateway, type JsonObject } from "./llmGateway.js";

function stream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(chunks.map((chunk) => "data: " + (typeof chunk === "string" ? chunk : JSON.stringify(chunk)) + "\r\n\r\n").join(""));
  return new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } });
}

test("Responses history, images, function calls and custom patch inputs convert to Chat", () => {
  const result = responsesToChat({ model: "test", instructions: "system", tools: [{ type: "custom", name: "apply_patch" }], input: [
    { role: "developer", content: "rules" }, { role: "user", content: [{ type: "input_text", text: "edit" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }] },
    { type: "reasoning", summary: [{ type: "summary_text", text: "plan the edit" }] },
    { type: "custom_tool_call", name: "apply_patch", call_id: "a", input: "*** Begin Patch\n*** End Patch" },
    { type: "function_call", name: "bash", call_id: "b", arguments: '{"command":"pwd"}' },
    { type: "custom_tool_call_output", call_id: "a", output: "ok" }, { type: "function_call_output", call_id: "b", output: "workspace" },
  ], tool_choice: { type: "custom", name: "apply_patch" }, reasoning: { effort: "high" }, max_output_tokens: 99 });
  assert.deepEqual(result.body.tool_choice, { type: "function", function: { name: "apply_patch" } });
  assert.equal(result.body.reasoning_effort, "high");
  assert.equal(result.body.max_completion_tokens, 99);
  assert.equal(result.customTools.has("apply_patch"), true);
  const messages = result.body.messages as JsonObject[];
  assert.equal(messages[1]?.role, "system");
  assert.equal((messages[3]?.tool_calls as unknown[]).length, 2);
  assert.equal(messages[4]?.tool_call_id, "a");
  assert.equal(messages[3]?.reasoning_content, "plan the edit");
});

test("fragmented UTF-8 SSE, reasoning, text and parallel tools produce complete Responses lifecycle", async () => {
  const patch = "*** Begin Patch\n*** Add File: hello.txt\n+你好\n*** End Patch";
  const args = JSON.stringify({ input: patch });
  const events: JsonObject[] = [];
  const result = await chatToResponses(stream([
    { choices: [{ index: 0, delta: { reasoning_content: "思考" } }] },
    { choices: [{ index: 0, delta: { content: "你好" } }] },
    { choices: [{ index: 0, delta: { tool_calls: [
      { index: 0, id: "call_", function: { name: "apply_", arguments: args.slice(0, 15) } },
      { index: 1, id: "b", function: { name: "bash", arguments: '{"command":' } },
    ] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [ { index: 1, function: { arguments: '"pwd"}' } }, { index: 0, id: "patch", function: { name: "patch", arguments: args.slice(15) } } ] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 } }, "[DONE]",
  ]), "test", new Set(["apply_patch"]), (event) => events.push(event));
  assert.equal(result.status, "completed");
  const output = result.output as JsonObject[];
  assert.equal(output.find((item) => item.type === "custom_tool_call")?.input, patch);
  assert.equal(output.find((item) => item.type === "custom_tool_call")?.call_id, "call_patch");
  assert.equal(output.find((item) => item.type === "function_call")?.arguments, '{"command":"pwd"}');
  assert.equal((result.usage as JsonObject).total_tokens, 12);
  assert.equal(events[0]?.type, "response.created");
  assert.equal(events.at(-1)?.type, "response.completed");
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, i) => i));
});

test("gateway never marks a truncated upstream stream as completed", async () => {
  await assert.rejects(chatToResponses(stream([{ choices: [{ delta: { content: "partial" } }] }]), "test", new Set(), () => {}), /finish_reason/);
  assert.throws(() => responsesToChat({ model: "x", previous_response_id: "old", input: [] }), /complete input history/);
  assert.throws(() => responsesToChat({ model: "x", input: [], tools: [{ type: "web_search" }] }), /Unsupported Responses tool/);
});

test("SSE decoder supports CRLF and split multibyte characters", async () => {
  const values: string[] = [];
  for await (const data of sseData(stream([{ value: "你好" }, "[DONE]"]))) values.push(data);
  assert.deepEqual(values, ['{"value":"你好"}', "[DONE]"]);
});

test("HTTP gateway authenticates, translates Chat and forwards Responses without exposing upstream credentials", async (t) => {
  let seen: { url?: string; authorization?: string; body?: JsonObject } = {};
  const upstream = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      seen = { url: req.url, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString()) };
      if (req.url === "/v1/responses") { res.setHeader("content-type", "application/json"); res.end('{"id":"native"}'); return; }
      res.setHeader("content-type", "text/event-stream");
      res.end('data: {"choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  for (const wireApi of ["completions", "responses"] as const) {
    const gateway = await startLlmGateway({ type: "openai", baseUrl: "http://127.0.0.1:" + address.port + "/v1", apiKey: "test-upstream-key", wireApi });
    try {
      const denied = await fetch(gateway.url + "/responses", { method: "POST" });
      assert.equal(denied.status, 401);
      const response = await fetch(gateway.url + "/responses", { method: "POST", headers: { authorization: "Bearer " + gateway.token }, body: JSON.stringify({ model: "test", input: "hi", stream: false }) });
      assert.equal(response.status, 200);
      const result = await response.json() as JsonObject;
      assert.equal(wireApi === "responses" ? result.id : result.status, wireApi === "responses" ? "native" : "completed");
      assert.equal(seen.authorization, "Bearer test-upstream-key");
      assert.equal(seen.url, "/v1/" + (wireApi === "responses" ? "responses" : "chat/completions"));
      assert.equal(JSON.stringify(result).includes("test-upstream-key"), false);
    } finally { await gateway.close(); }
  }
});

test("tool images remain visual inputs and parallel tool results stay adjacent", () => {
  const result = responsesToChat({ model: "vision", input: [
    { type: "reasoning", summary: [{ type: "summary_text", text: "inspect" }] },
    { role: "assistant", content: "Checking the page" },
    { type: "function_call", name: "screenshot", call_id: "image", arguments: "{}" },
    { type: "function_call", name: "echo", call_id: "text", arguments: "{}" },
    { type: "function_call_output", call_id: "image", output: [{ type: "input_text", text: "screenshot" }, { type: "input_image", image_url: "data:image/png;base64,AA==" }] },
    { type: "function_call_output", call_id: "text", output: "done" },
  ] });
  const messages = result.body.messages as JsonObject[];
  assert.deepEqual(messages.map((message) => message.role), ["assistant", "tool", "tool", "user"]);
  assert.equal(messages[0]?.reasoning_content, "inspect");
  assert.equal((messages[0]?.tool_calls as unknown[]).length, 2);
  assert.equal((messages[3]?.content as JsonObject[])[1]?.type, "image_url");
});
