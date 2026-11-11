import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { object, responsesToChat, chatToResponses, sseData, startLlmGateway, normalizeCodexImageResponse, sanitizeCodexImageRequest, compactCodexImageRequest, complexityModelFallback, codexImagegenHttpBody, unsupportedImageRequestParam, type JsonObject } from "./llmGateway.js";

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


test("image generation tool and image history translate through Chat Completions", async () => {
  const translated = responsesToChat({ model: "chat", input: [
    { type: "image_generation_call", id: "ig_previous", status: "completed", result: "aW1hZ2U=", revised_prompt: "A cat" },
  ], tools: [{ type: "image_generation" }], tool_choice: { type: "image_generation" } });
  assert.equal(translated.imageGeneration, true);
  assert.deepEqual(translated.body.tool_choice, { type: "function", function: { name: "image_generation" } });
  const messages = translated.body.messages as JsonObject[];
  assert.equal(messages[0]?.role, "assistant");
  assert.equal((messages[1]?.content as JsonObject[])[1]?.type, "image_url");
  const events: JsonObject[] = [];
  const response = await chatToResponses(stream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_image", function: { name: "image_generation", arguments: '{"prompt":"A cat"}' } }] }, finish_reason: "tool_calls" }] }, "[DONE]",
  ]), "chat", new Set(), (event) => events.push(event), async (args) => {
    assert.equal(args.prompt, "A cat");
    return { result: "aW1hZ2U=", revised_prompt: "A cat" };
  });
  assert.equal((response.output as JsonObject[])[0]?.type, "image_generation_call");
  assert.equal((response.output as JsonObject[])[0]?.result, "aW1hZ2U=");
  assert.ok(events.some((event) => event.type === "response.image_generation_call.in_progress"));
  assert.equal(events.at(-1)?.type, "response.completed");
});

test("sanitizeCodexImageRequest drops complexity unless the model is GPT Image 2.6", () => {
  const request = {
    prompt: "A cat", model: "gpt-image-2", quality: "medium", size: "auto", background: "auto",
    complexity: "medium", style: "vivid", response_format: "b64_json",
  };
  assert.deepEqual(sanitizeCodexImageRequest("gpt-image-1.5", request), {
    prompt: "A cat", model: "gpt-image-1.5", quality: "medium",
  });
  assert.equal(sanitizeCodexImageRequest("gpt-image-2", request).complexity, undefined);
  assert.equal(sanitizeCodexImageRequest("gpt-image-2.5-sunburst", { ...request, quality: "xhigh" }).quality, "xhigh");
  assert.equal(sanitizeCodexImageRequest("gpt-image-1.5", { ...request, quality: "xhigh" }).quality, undefined);
  assert.deepEqual(sanitizeCodexImageRequest("gpt-image-2.6-sunburst", request), {
    prompt: "A cat", model: "gpt-image-2.6-sunburst", quality: "medium", size: "auto", background: "auto", complexity: "medium",
  });
});

test("sanitizeCodexImageRequest omits Codex 0.167 auto extras that make 1.x/2 proxies inject complexity", () => {
  const codexBody = {
    prompt: "帮我生成一张原神的logo图",
    background: "auto",
    model: "gpt-image-2",
    quality: "auto",
    size: "auto",
  };
  assert.deepEqual(sanitizeCodexImageRequest("gpt-image-1.5", codexBody), {
    prompt: "帮我生成一张原神的logo图",
    model: "gpt-image-1.5",
  });
  assert.equal("complexity" in sanitizeCodexImageRequest("gpt-image-1.5", codexBody), false);
  assert.deepEqual(sanitizeCodexImageRequest("gpt-image-2.6-flare", codexBody), {
    prompt: "帮我生成一张原神的logo图",
    background: "auto",
    model: "gpt-image-2.6-flare",
    quality: "auto",
    size: "auto",
  });
  assert.deepEqual(compactCodexImageRequest({
    model: "gpt-image-1.5", prompt: "A cat", quality: "medium", n: 1,
  }), { model: "gpt-image-1.5", prompt: "A cat", n: 1 });
  assert.equal(compactCodexImageRequest({ model: "gpt-image-1.5", prompt: "A cat" }), undefined);
});

test("sanitizeCodexImageRequest strips Codex 0.167 opaque-background imagegen bodies", () => {
  const liveCall = { prompt: "帮我生成一张原神的logo图", transparent_background: false };
  const body = codexImagegenHttpBody(liveCall.prompt, liveCall.transparent_background);
  assert.deepEqual(body, {
    prompt: liveCall.prompt, background: "opaque", model: "gpt-image-2", quality: "auto", size: "auto",
  });
  assert.deepEqual(sanitizeCodexImageRequest("gpt-image-1.5", body), {
    prompt: liveCall.prompt, model: "gpt-image-1.5",
  });
  assert.deepEqual(sanitizeCodexImageRequest("gpt-image-2", body), {
    prompt: liveCall.prompt, model: "gpt-image-2",
  });
  assert.equal("complexity" in sanitizeCodexImageRequest("gpt-image-2", body), false);
  assert.deepEqual(sanitizeCodexImageRequest("gpt-image-1.5", { prompt: "A cat", transparent_background: false, model: "gpt-image-2" }), {
    prompt: "A cat", model: "gpt-image-1.5",
  });
  assert.deepEqual(sanitizeCodexImageRequest("gpt-image-1.5", { prompt: "A cat", transparent_background: true }), {
    prompt: "A cat", model: "gpt-image-1.5", background: "transparent",
  });
  const complexityError = Buffer.from(JSON.stringify({
    error: { message: "Complexity 'medium' is not supported for this image model.", param: "complexity", type: "image_generation_user_error" },
  }));
  assert.deepEqual(complexityModelFallback("gpt-image-2", { model: "gpt-image-2", prompt: "A cat" }, 400, complexityError), {
    model: "gpt-image-1.5", prompt: "A cat",
  });
  assert.equal(complexityModelFallback("gpt-image-1.5", { model: "gpt-image-1.5", prompt: "A cat" }, 400, complexityError), undefined);
});

test("unsupportedImageRequestParam reads OpenAI image model rejection fields", () => {
  const body = Buffer.from(JSON.stringify({
    error: { message: "Complexity 'medium' is not supported for this image model.", type: "image_generation_user_error", param: "complexity", code: "invalid_value" },
  }));
  assert.equal(unsupportedImageRequestParam(400, body), "complexity");
  assert.equal(unsupportedImageRequestParam(400, Buffer.from(JSON.stringify({
    error: { message: "Quality 'xhigh' is not supported for this image model." },
  }))), "quality");
  assert.equal(unsupportedImageRequestParam(400, Buffer.from(JSON.stringify({
    error: { message: '当前生图模型不支持 complexity: "medium"。' },
  }))), "complexity");
  assert.equal(unsupportedImageRequestParam(200, body), undefined);
});

test("Codex image responses always include created", () => {
  const normalized = object(JSON.parse(normalizeCodexImageResponse(
    200, "application/json", Buffer.from(JSON.stringify({ data: [{ b64_json: "QQ==" }] })),
  ).toString("utf8")));
  assert.equal(typeof normalized.created, "number");
  assert.deepEqual(normalized.data, [{ b64_json: "QQ==" }]);
  assert.equal(normalizeCodexImageResponse(400, "application/json", Buffer.from("nope")).toString("utf8"), "nope");
});

test("gateway strips hosted image tools and proxies Codex native /images/generations", async (t) => {
  const requests: Array<{ url?: string; body: JsonObject; authorization?: string }> = [];
  const upstream = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = object(JSON.parse(Buffer.concat(chunks).toString()));
      requests.push({ url: req.url, body, authorization: req.headers.authorization });
      if (req.url === "/v1/images/generations") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }));
        return;
      }
      if (req.url === "/v1/responses") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "native_image", output: [] }));
        return;
      }
      res.setHeader("content-type", "text/event-stream");
      res.end('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const imageBase = "http://127.0.0.1:" + address.port + "/v1";
  for (const wireApi of ["responses", "completions"] as const) {
    const unconfigured = await startLlmGateway({ type: "openai", baseUrl: imageBase, apiKey: "image-test-key", wireApi });
    try {
      const denied = await fetch(unconfigured.url + "/images/generations", {
        method: "POST", headers: { authorization: "Bearer " + unconfigured.token, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-image-2", prompt: "A cat" }),
      });
      assert.equal(denied.status, 400);
    } finally { await unconfigured.close(); }
    const gateway = await startLlmGateway({
      type: "openai", baseUrl: imageBase, apiKey: "chat-key", wireApi,
      imageGenerationModel: "gpt-image-1.5", imageGenerationBaseUrl: imageBase, imageGenerationApiKey: "image-test-key",
    });
    try {
      const before = requests.length;
      const chat = await fetch(gateway.url + "/responses", {
        method: "POST", headers: { authorization: "Bearer " + gateway.token, "content-type": "application/json" },
        body: JSON.stringify({ model: "chat", input: "A cat", stream: false, tools: [{ type: "image_generation", model: "unconfigured-model" }] }),
      });
      assert.equal(chat.status, 200, await chat.text());
      const forwardedTools = (requests.at(-1)?.body.tools as JsonObject[] | undefined) ?? [];
      assert.equal(forwardedTools.some((tool) => tool.type === "image_generation"), false);
      const generated = await fetch(gateway.url + "/images/generations", {
        method: "POST", headers: { authorization: "Bearer " + gateway.token, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-image-2", prompt: "A cat", quality: "auto", complexity: "medium", style: "vivid" }),
      });
      assert.equal(generated.status, 200);
      const generatedPayload = object(await generated.json());
      assert.equal(typeof generatedPayload.created, "number");
      assert.deepEqual(generatedPayload.data, [{ b64_json: "aW1hZ2U=" }]);
      assert.equal(requests.length, before + 2);
      assert.equal(requests.at(-1)?.url, "/v1/images/generations");
      assert.equal(requests.at(-1)?.authorization, "Bearer image-test-key");
      assert.deepEqual(requests.at(-1)?.body, { model: "gpt-image-1.5", prompt: "A cat" });
    } finally { await gateway.close(); }
  }
});

test("gateway retries image generation after an unsupported param rejection", async (t) => {
  const requests: JsonObject[] = [];
  const upstream = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = object(JSON.parse(Buffer.concat(chunks).toString()));
      requests.push(body);
      res.setHeader("content-type", "application/json");
      if (body.size) {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: { message: "Size '1024x1024' is not supported for this image model.", param: "size", type: "image_generation_user_error" },
        }));
        return;
      }
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: "aW1hZ2U=" }] }));
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const imageBase = "http://127.0.0.1:" + address.port + "/v1";
  const gateway = await startLlmGateway({
    type: "openai", baseUrl: imageBase, apiKey: "chat-key",
    imageGenerationModel: "gpt-image-1.5", imageGenerationBaseUrl: imageBase, imageGenerationApiKey: "image-test-key",
  });
  try {
    const generated = await fetch(gateway.url + "/images/generations", {
      method: "POST", headers: { authorization: "Bearer " + gateway.token, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "A cat", quality: "medium", size: "1024x1024", complexity: "medium" }),
    });
    assert.equal(generated.status, 200, await generated.text());
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.complexity, undefined);
    assert.equal(requests[0]?.size, "1024x1024");
    assert.deepEqual(requests[1], { model: "gpt-image-1.5", prompt: "A cat", quality: "medium" });
  } finally { await gateway.close(); }
});

test("gateway forwards Codex 0.167 imagegen without auto extras so proxies cannot inject complexity", async (t) => {
  const requests: JsonObject[] = [];
  const upstream = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = object(JSON.parse(Buffer.concat(chunks).toString()));
      requests.push(body);
      res.setHeader("content-type", "application/json");
      if (body.complexity != null || body.quality != null || body.size != null || body.background != null) {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: { message: '当前生图模型不支持 complexity: "medium"。', type: "invalid_request_error" },
        }));
        return;
      }
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: "aW1hZ2U=" }] }));
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const imageBase = "http://127.0.0.1:" + address.port + "/v1";
  const gateway = await startLlmGateway({
    type: "openai", baseUrl: imageBase, apiKey: "chat-key",
    imageGenerationModel: "gpt-image-1.5", imageGenerationBaseUrl: imageBase, imageGenerationApiKey: "image-test-key",
  });
  try {
    const generated = await fetch(gateway.url + "/images/generations", {
      method: "POST", headers: { authorization: "Bearer " + gateway.token, "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "帮我生成一张原神的logo图",
        background: "auto",
        model: "gpt-image-2",
        quality: "auto",
        size: "auto",
      }),
    });
    assert.equal(generated.status, 200, await generated.text());
    assert.equal(requests.length, 1, JSON.stringify(requests));
    assert.deepEqual(requests[0], { model: "gpt-image-1.5", prompt: "帮我生成一张原神的logo图" });
  } finally { await gateway.close(); }
});

test("gateway forwards the live prompt+transparent_background=false Codex 0.167 body without complexity", async (t) => {
  const requests: JsonObject[] = [];
  const upstream = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = object(JSON.parse(Buffer.concat(chunks).toString()));
      requests.push(body);
      res.setHeader("content-type", "application/json");
      if (body.complexity != null || body.quality != null || body.size != null || body.background != null) {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: { message: "Complexity 'medium' is not supported for this image model.", param: "complexity", type: "image_generation_user_error", code: "invalid_value" },
        }));
        return;
      }
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: "aW1hZ2U=" }] }));
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const imageBase = "http://127.0.0.1:" + address.port + "/v1";
  const gateway = await startLlmGateway({
    type: "openai", baseUrl: imageBase, apiKey: "chat-key",
    imageGenerationModel: "gpt-image-2", imageGenerationBaseUrl: imageBase, imageGenerationApiKey: "image-test-key",
  });
  try {
    const generated = await fetch(gateway.url + "/images/generations", {
      method: "POST", headers: { authorization: "Bearer " + gateway.token, "content-type": "application/json" },
      body: JSON.stringify(codexImagegenHttpBody("帮我生成一张原神的logo图", false)),
    });
    assert.equal(generated.status, 200, await generated.text());
    assert.equal(requests.length, 1, JSON.stringify(requests));
    assert.deepEqual(requests[0], { model: "gpt-image-2", prompt: "帮我生成一张原神的logo图" });
  } finally { await gateway.close(); }
});

test("gateway falls back from gpt-image-2 to gpt-image-1.5 when a proxy still injects complexity", async (t) => {
  const requests: JsonObject[] = [];
  const upstream = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = object(JSON.parse(Buffer.concat(chunks).toString()));
      requests.push(body);
      res.setHeader("content-type", "application/json");
      if (body.model !== "gpt-image-1.5") {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: { message: "Complexity 'medium' is not supported for this image model.", param: "complexity", type: "image_generation_user_error" },
        }));
        return;
      }
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: "aW1hZ2U=" }] }));
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const imageBase = "http://127.0.0.1:" + address.port + "/v1";
  const gateway = await startLlmGateway({
    type: "openai", baseUrl: imageBase, apiKey: "chat-key",
    imageGenerationModel: "gpt-image-2", imageGenerationBaseUrl: imageBase, imageGenerationApiKey: "image-test-key",
  });
  try {
    const generated = await fetch(gateway.url + "/images/generations", {
      method: "POST", headers: { authorization: "Bearer " + gateway.token, "content-type": "application/json" },
      body: JSON.stringify(codexImagegenHttpBody("A cat", false)),
    });
    assert.equal(generated.status, 200, await generated.text());
    assert.deepEqual(requests.at(-1), { model: "gpt-image-1.5", prompt: "A cat" });
  } finally { await gateway.close(); }
});

test("gateway retries a compact body when a proxy injects complexity the Codex payload never sent", async (t) => {
  const requests: JsonObject[] = [];
  const upstream = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = object(JSON.parse(Buffer.concat(chunks).toString()));
      requests.push(body);
      res.setHeader("content-type", "application/json");
      if (body.quality != null) {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: { message: '当前生图模型不支持 complexity: "medium"。' },
        }));
        return;
      }
      res.end(JSON.stringify({ created: 1, data: [{ b64_json: "aW1hZ2U=" }] }));
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { upstream.closeAllConnections(); upstream.close(() => resolve()); }));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const imageBase = "http://127.0.0.1:" + address.port + "/v1";
  const gateway = await startLlmGateway({
    type: "openai", baseUrl: imageBase, apiKey: "chat-key",
    imageGenerationModel: "gpt-image-1.5", imageGenerationBaseUrl: imageBase, imageGenerationApiKey: "image-test-key",
  });
  try {
    const generated = await fetch(gateway.url + "/images/generations", {
      method: "POST", headers: { authorization: "Bearer " + gateway.token, "content-type": "application/json" },
      body: JSON.stringify({ prompt: "A cat", quality: "medium", complexity: "medium" }),
    });
    assert.equal(generated.status, 200, await generated.text());
    assert.equal(requests.length, 2, JSON.stringify(requests));
    assert.deepEqual(requests[0], { model: "gpt-image-1.5", prompt: "A cat", quality: "medium" });
    assert.deepEqual(requests[1], { model: "gpt-image-1.5", prompt: "A cat" });
  } finally { await gateway.close(); }
});


test("client tool search loads namespaced tools and preserves their native call identity", async () => {
  const searchTool = { type: "tool_search", execution: "client", parameters: { type: "object", properties: { query: { type: "string" } } } };
  const first = responsesToChat({ model: "chat", input: "Generate a puppy", tools: [searchTool] });
  const search = await chatToResponses(stream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "search_1", function: { name: "tool_search", arguments: '{"query":"+mcp_docs"}' } }] }, finish_reason: "tool_calls" }] }, "[DONE]",
  ]), "chat", first.customTools, () => {}, undefined, first);
  const searchCall = (search.output as JsonObject[])[0]!;
  assert.equal(searchCall.type, "tool_search_call");
  assert.equal(searchCall.execution, "client");
  assert.deepEqual(searchCall.arguments, { query: "+mcp_docs" });
  const loaded = { type: "namespace", name: "mcp__docs", tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: { q: { type: "string" } } } }] };
  const second = responsesToChat({ model: "chat", tools: [searchTool], input: [
    searchCall, { type: "tool_search_output", execution: "client", call_id: "search_1", tools: [loaded] },
  ] });
  const docsTool = (second.body.tools as JsonObject[]).find((entry) => object(entry.function).name === "mcp__docs__lookup");
  assert.ok(docsTool);
  assert.deepEqual((second.body.messages as JsonObject[]).map((message) => message.role), ["assistant", "tool"]);
  const generated = await chatToResponses(stream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "docs_1", function: { name: "mcp__docs__lookup", arguments: '{"q":"auth"}' } }] }, finish_reason: "tool_calls" }] }, "[DONE]",
  ]), "chat", second.customTools, () => {}, undefined, second);
  const docsCall = (generated.output as JsonObject[])[0]!;
  assert.equal(docsCall.name, "lookup");
  assert.equal(docsCall.namespace, "mcp__docs");
  const replay = responsesToChat({ model: "chat", tools: [loaded], input: [docsCall] });
  assert.equal(object((object((replay.body.messages as JsonObject[])[0]).tool_calls as JsonObject[])[0]!.function).name, "mcp__docs__lookup");
});
