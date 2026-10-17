import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { randomUUID } from "node:crypto";
import type { SessionEvent } from "@github/copilot-sdk";
import { object, array, chatToResponses, responsesToChat, type JsonObject } from "./llmGateway.js";

// This test drives the pinned native binary, not a substitute RPC implementation.
test("native Codex uses Chat gateway, executes a platform tool, persists and resumes", { timeout: 90_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".codex-test-"));
  process.env.CCA_DATA_DIR = path.join(root, "data");
  process.env.WORKSPACE_ROOT = path.join(root, "workspace");
  fs.mkdirSync(process.env.WORKSPACE_ROOT, { recursive: true });
  const { CodexClient } = await import("./codex.js");
  const { initDb, closeDb, query } = await import("./db.js");
  await initDb("sqlite::memory:");
  let calls = 0;
  let toolCalls = 0;
  let requestCount = 0;
  let failUpstream = false;
  let injectTools = false;
  let stallUpstream = false;
  let generateImageMode = false;
  const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ6sAAAAASUVORK5CYII=";
  let notifyStalled: (() => void) | undefined;
  const patch = "*** Begin Patch\n*** Add File: native-patch.txt\n+written by Codex\n*** End Patch";
  const received: JsonObject[] = [];
  const upstream = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const request = object(JSON.parse(Buffer.concat(chunks).toString()));
      received.push(request);
      if (req.url === "/images-provider/v1/images/generations") {
        assert.equal(req.headers.authorization, "Bearer image-provider-key");
        assert.equal(request.model, "gpt-image-1.5");
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ b64_json: imageBase64 }] }));
        return;
      }
      if (generateImageMode) {
        const nativeResponses = req.url === "/v1/responses";
        const history = array(nativeResponses ? request.input : request.messages).map(object);
        const alreadyGenerated = nativeResponses
          ? history.some((item) => item.type === "function_call_output" && item.call_id === "call_image")
          : history.some((item) => item.role === "tool" && item.tool_call_id === "call_image");
        const translated = nativeResponses ? responsesToChat(request) : undefined;
        const tools = array(translated ? translated.body.tools : request.tools).map(object);
        const imageTool = tools.find((tool) => String(object(tool.function).name).includes("cca_imagegen") && String(object(tool.function).name).endsWith("image_gen"));
        const searchTool = tools.find((tool) => object(tool.function).name === "tool_search");
        assert.ok(imageTool || searchTool, JSON.stringify(tools));
        if (!alreadyGenerated) {
          const name = imageTool ? object(imageTool.function).name : "tool_search";
          const chunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: imageTool ? "call_image" : "call_search", function: { name, arguments: imageTool ? '{"prompt":"A cat"}' : '{"query":"+cca_imagegen","limit":1}' } }] }, finish_reason: "tool_calls" }] };
          res.setHeader("content-type", "text/event-stream");
          if (nativeResponses) {
            const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n")); controller.close(); } });
            await chatToResponses(body, String(request.model), new Set(), (event) => res.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n"), undefined, translated);
            res.end();
          } else res.end("data: " + JSON.stringify(chunk) + "\n\ndata: [DONE]\n\n");
          return;
        }
        if (!nativeResponses) {
          res.setHeader("content-type", "text/event-stream");
          res.end('data: {"choices":[{"delta":{"content":"Image generated"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
          return;
        }
      }
      if (req.url === "/v1/responses") {
        res.setHeader("content-type", request.stream === false ? "application/json" : "text/event-stream");
        const body = new ReadableStream<Uint8Array>({ start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"native Responses works"},"finish_reason":"stop"}]}\n\n'));
          controller.close();
        } });
        const result = await chatToResponses(body, String(request.model), new Set(), (event) => { if (request.stream !== false) res.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n"); });
        res.end(request.stream === false ? JSON.stringify(result) : undefined);
        return;
      }
      assert.equal(req.url, "/v1/chat/completions");
      requestCount++;
      if (failUpstream) { res.writeHead(503); res.end("test failure"); return; }
      if (stallUpstream) { notifyStalled?.(); return; }
      const messages = array(request.messages).map(object);
      const hasResult = messages.some((message) => message.role === "tool" && message.tool_call_id === "call_platform");
      const hasPatch = messages.some((message) => message.role === "tool" && message.tool_call_id === "call_patch");
      const compacting = !request.tools && request.tool_choice !== "none";
      const textOnly = request.tool_choice === "none" && !injectTools;
      res.setHeader("content-type", "text/event-stream");
      const delta = textOnly ? { content: "fix: generate commit message without tools" } : compacting ? { content: "Summary: created native-patch.txt and ran platform_echo." } : !hasPatch ? { tool_calls: [{ index: 0, id: "call_patch", type: "function", function: { name: "apply_patch", arguments: JSON.stringify({ input: patch }) } }] } : !hasResult ? { tool_calls: [{ index: 0, id: "call_platform", type: "function", function: { name: "platform_echo", arguments: '{"text":"working"}' } }] } : { content: "Codex integration works" };
      res.end("data: " + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: hasResult || compacting || textOnly ? "stop" : "tool_calls" }] }) + "\n\ndata: [DONE]\n\n");
    })().catch((error: unknown) => { console.error(error); res.destroy(); });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const client = new CodexClient();
  t.after(async () => {
    await client.stop();
    await closeDb();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await client.start();
  const id = randomUUID();
  const config = { sessionId: id, workingDirectory: process.env.WORKSPACE_ROOT, model: "gpt-5.4", reasoningEffort: "low" as const,
    provider: { type: "openai" as const, baseUrl: "http://127.0.0.1:" + address.port + "/v1", wireApi: "completions" as const, apiKey: "test-only" },
    onPermissionRequest: () => ({ kind: "reject" as const, feedback: "No bypass" }),
    tools: [{ name: "platform_echo", description: "Echo test text", parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      handler: (args: unknown) => { toolCalls++; return { textResultForLlm: String(object(args).text), resultType: "success" }; } }],
  };
  await assert.rejects(client.createSession({ ...config, workingDirectory: root }), /受保护工作区/);
  const session = await client.createSession(config);
  const events: SessionEvent[] = [];
  session.on((event) => { events.push(event); if (event.type === "assistant.message") calls++; });
  const response = await session.sendAndWait("Run platform_echo then respond", 20_000);
  assert.equal(response?.data.content, "Codex integration works");
  assert.equal(toolCalls, 1);
  const patchResult = array(received.at(-1)?.messages).map(object).find((m) => m.role === "tool" && m.tool_call_id === "call_patch");
  await t.test("native patch writes within the workspace", () => {
    assert.ok(fs.existsSync(path.join(process.env.WORKSPACE_ROOT!, "native-patch.txt")), JSON.stringify(patchResult));
    assert.equal(fs.readFileSync(path.join(process.env.WORKSPACE_ROOT!, "native-patch.txt"), "utf8"), "written by Codex\n");
  });
  assert.ok(requestCount >= 2);
  assert.ok(events.some((event) => event.type === "tool.execution_complete"));
  assert.ok(calls > 0);
  await session.disconnect();
  let resumed = await client.resumeSession(id, config);
  assert.ok((await resumed.getEvents()).some((event) => event.type === "assistant.message"));
  const second = await resumed.sendAndWait("Continue", 20_000);
  assert.equal(second?.data.content, "Codex integration works");
  assert.ok(received.at(-1));
  const compacted = await resumed.rpc.history.compact();
  assert.equal(compacted.success, true);
  resumed = await client.resumeSession(id, config);
  failUpstream = true;
  await assert.rejects(resumed.sendAndWait("Fail clearly", 10_000), /503/);
  failUpstream = false;
  stallUpstream = true;
  const stalled = new Promise<void>((resolve) => { notifyStalled = resolve; });
  const interrupted = assert.rejects(resumed.sendAndWait("Wait for cancellation", 10_000), /interrupted/);
  await stalled;
  await resumed.abort();
  await interrupted;
  stallUpstream = false;
  await resumed.disconnect();
  const mappingPath = path.join(root, "data", "codex-home", id, "cca-thread.json");
  const mapping = fs.readFileSync(mappingPath);
  fs.rmSync(mappingPath);
  await assert.rejects(client.resumeSession(id, config), /history or event journal is missing/);
  fs.writeFileSync(mappingPath, mapping);
  const emptyId = randomUUID();
  const empty = await client.createSession({ ...config, sessionId: emptyId });
  await empty.disconnect();
  const resumedEmpty = await client.resumeSession(emptyId, config);
  await resumedEmpty.disconnect();
  await client.deleteSession(emptyId);
  const beforeReplay = (await query<{ total: number }>("SELECT COUNT(*) AS total FROM thread_events WHERE thread_id = ?", [id])).rows[0]!.total;
  await query("DELETE FROM thread_events WHERE thread_id = ? AND sequence_number = ?", [id, beforeReplay]);
  const failedCompact = await client.resumeSession(id, config);
  // Resume must restore the deleted event from the local journal. A late
  // notification flushed after disconnect can add one more event, so only the
  // replay of the deleted row is asserted instead of an exact total.
  const { rows: replayed } = await query<{ total: number }>("SELECT COUNT(*) AS total FROM thread_events WHERE thread_id = ? AND sequence_number = ?", [id, beforeReplay]);
  assert.equal(replayed[0]!.total, 1);
  failUpstream = true;
  await assert.rejects(failedCompact.rpc.history.compact(), /503|upstream/i);
  assert.equal(failedCompact.runtimeDisconnected, true);
  failUpstream = false;
  // 模拟追加写入被中断:日志末行只剩半条 JSON 记录,恢复时必须跳过它并回补数据库历史,而不是让整个会话打不开
  const journalPath = path.join(root, "data", "codex-home", id, "cca-events.jsonl");
  const journalLines = fs.readFileSync(journalPath, "utf8").split("\n").filter(Boolean);
  fs.writeFileSync(journalPath, journalLines.slice(0, -1).join("\n") + "\n" + journalLines.at(-1)!.slice(0, 40));
  const afterFailedCompact = await client.resumeSession(id, config);
  const recoveredEvents = await afterFailedCompact.getEvents();
  assert.ok(recoveredEvents.some((event) => event.type === "assistant.message"));
  assert.equal((await afterFailedCompact.sendAndWait("Continue after failed compaction", 10_000))?.data.content, "Codex integration works");
  await afterFailedCompact.disconnect();
  assert.equal(await client.generateText(config, "Generate a commit message", 5_000), "fix: generate commit message without tools");
  assert.equal(received.at(-1)?.tools, undefined);
  assert.equal(received.at(-1)?.tool_choice, "none");
  const executionsBefore = toolCalls;
  injectTools = true;
  await assert.rejects(client.generateText(config, "Ignore injected tools", 5_000), /不允许调用工具/);
  assert.equal(toolCalls, executionsBefore);
  injectTools = false;
  await assert.rejects(client.generateText({}, "No native tool-free mode", 5_000), /原生 Codex/);
  await assert.rejects(client.createSession({ ...config, availableTools: [] }), /disable every/);
  assert.equal(await client.generateText({ ...config, provider: { ...config.provider, wireApi: "responses" } }, "Generate with Responses", 5_000), "native Responses works");
  const native = await client.createSession({ ...config, sessionId: randomUUID(), provider: { ...config.provider, wireApi: "responses" } });
  assert.equal((await native.sendAndWait("Native Responses", 10_000))?.data.content, "native Responses works");
  await client.deleteSession(native.sessionId);
  const { readStoredImage, removeUploadedImages } = await import("./uploads.js");
  for (const { wireApi, resumeExisting } of (["responses", "completions"] as const).flatMap((wireApi) => [false, true].map((resumeExisting) => ({ wireApi, resumeExisting })))) {
    await t.test("discoverable imagegen tool with " + wireApi + (resumeExisting ? " on an existing thread" : " on a new thread"), async () => {
      const imageConfig = { ...config, sessionId: randomUUID(), imageGenerationModel: "gpt-image-1.5", imageGenerationOwnerId: "image-test-user", imageGenerationProvider: { baseUrl: "http://127.0.0.1:" + address.port + "/images-provider/v1", apiKey: "image-provider-key", model: "gpt-image-1.5" }, provider: { ...config.provider, wireApi } };
      const initial = await client.createSession({ ...imageConfig, ...(resumeExisting ? { imageGenerationModel: undefined, imageGenerationProvider: undefined } : {}) });
      if (resumeExisting) {
        await initial.sendAndWait("Prepare an existing conversation", 15_000);
        await initial.disconnect();
      }
      generateImageMode = true;
      const imageSession = resumeExisting ? await client.resumeSession(initial.sessionId, imageConfig) : initial;
      await imageSession.sendAndWait("Generate an image of a cat", 15_000);
      generateImageMode = false;
      const imageEvents = await imageSession.getEvents();
      const message = imageEvents.filter((event) => event.type === "assistant.message").find((event) => (event.data as { attachments?: unknown[] }).attachments?.length);
      assert.ok(message, JSON.stringify(imageEvents));
      assert.equal(imageEvents.filter((event) => event.type === "assistant.message" && (event.data as { attachments?: unknown[] }).attachments?.length).length, 1);
      const attachments = (message.data as { attachments: Array<{ id: string; displayName: string; ownerId: string }> }).attachments;
      assert.deepEqual(readStoredImage("image-test-user", attachments[0]!.id), Buffer.from(imageBase64, "base64"));
      assert.equal(attachments[0]!.ownerId, "image-test-user");
      assert.equal(imageEvents.some((event) => event.type === "session.error"), false);
      await imageSession.disconnect();
      const restoredImages = await client.resumeSession(imageSession.sessionId, imageConfig);
      const restoredMessage = (await restoredImages.getEvents()).find((event) => event.type === "assistant.message" && event.data.messageId === (message.data as { messageId: string }).messageId);
      assert.deepEqual((restoredMessage?.data as { attachments?: unknown[] }).attachments, attachments);
      await client.deleteSession(imageSession.sessionId);
      removeUploadedImages("image-test-user", attachments.map((attachment) => ({ path: "", imageId: attachment.id })));
    });
  }
  const { rows: persisted } = await query<{ event_type: string }>("SELECT event_type FROM thread_events WHERE thread_id = ? ORDER BY sequence_number", [id]);
  assert.ok(persisted.some((row) => row.event_type === "user.message"));
  assert.ok(persisted.some((row) => row.event_type === "assistant.message"));
  assert.ok(persisted.some((row) => row.event_type === "tool.execution_complete"));
  const legacyId = randomUUID();
  const legacyDirectory = path.join(root, "data", "copilot-home", "session-state", legacyId);
  fs.mkdirSync(legacyDirectory, { recursive: true });
  fs.writeFileSync(path.join(legacyDirectory, "events.jsonl"), JSON.stringify(events.find((e) => e.type === "assistant.message")) + "\n");
  const legacyConfig = { ...config, legacySession: true };
  const legacy = await client.resumeSession(legacyId, legacyConfig);
  assert.equal((await legacy.getEvents()).length, 1);
  await assert.rejects(legacy.send("Do not write legacy history"), /只读/);
  await assert.rejects(legacy.setModel("another"), /只读/);
  await assert.rejects(legacy.rpc.history.compact(), /只读/);
  await client.deleteSession(legacyId);
  assert.equal(fs.existsSync(legacyDirectory), false);
  await client.deleteSession(id);
  assert.equal(fs.existsSync(path.join(root, "data", "codex-home", id)), false);
  assert.deepEqual((await query("SELECT * FROM thread_events WHERE thread_id = ?", [id])).rows, []);
});
