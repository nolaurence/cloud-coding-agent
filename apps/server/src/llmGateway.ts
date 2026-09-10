import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";

export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as JsonObject;
}
export function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string");
  return value;
}
export function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected an array");
  return value;
}

export interface GatewayProvider {
  type: "openai" | "azure" | "anthropic";
  baseUrl: string;
  apiKey?: string;
  wireApi?: "completions" | "responses";
  azure?: { apiVersion?: string };
  reasoningEffort?: "max";
}

function contentParts(value: unknown): JsonObject[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  return array(value).map((raw) => {
    const part = object(raw);
    if (["input_text", "output_text", "text"].includes(text(part.type))) return { type: "text", text: text(part.text) };
    if (part.type === "input_image") return { type: "image_url", image_url: { url: text(part.image_url), ...(part.detail ? { detail: part.detail } : {}) } };
    throw new Error("Unsupported Responses content part: " + String(part.type));
  });
}

export function responsesToChat(request: JsonObject): { body: JsonObject; customTools: Set<string> } {
  if (request.previous_response_id) throw new Error("previous_response_id is not supported; send the complete input history");
  const messages: JsonObject[] = [];
  let reasoningContent: string | undefined;
  let toolImages: JsonObject[] = [];
  const flushToolImages = () => {
    if (toolImages.length) messages.push({ role: "user", content: toolImages });
    toolImages = [];
  };
  if (request.instructions) messages.push({ role: "system", content: text(request.instructions) });
  const input = typeof request.input === "string" ? [{ role: "user", content: request.input }] : array(request.input ?? []);
  const tools = array(request.tools ?? []);
  const customTools = new Set<string>();
  const chatTools = tools.map((raw) => {
    const tool = object(raw);
    if (tool.type === "function") return { type: "function", function: {
      name: text(tool.name), description: tool.description, parameters: tool.parameters ?? { type: "object", properties: {} },
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    } };
    if (tool.type === "custom") {
      const name = text(tool.name);
      customTools.add(name);
      return { type: "function", function: { name,
        description: String(tool.description ?? "") + "\nThis compatibility API exposes a JSON function, overriding freeform transport instructions above. Put the complete raw tool input in the input string; never put JSON wrappers or Markdown fences inside that string.",
        parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
      } };
    }
    throw new Error("Unsupported Responses tool: " + String(tool.type));
  });
  for (const raw of input) {
    const item = object(raw);
    if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") flushToolImages();
    if (item.type === "reasoning") {
      const summary = array(item.summary ?? []).map(object).filter((part) => part.type === "summary_text").map((part) => text(part.text)).join("\n");
      if (summary) reasoningContent = (reasoningContent ?? "") + summary;
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const call = { id: text(item.call_id), type: "function", function: { name: text(item.name),
        arguments: item.type === "custom_tool_call" ? JSON.stringify({ input: text(item.input) }) : text(item.arguments) } };
      const previous = messages.at(-1);
      if (previous?.role === "assistant") {
        previous.tool_calls = [...array(previous.tool_calls ?? []), call];
        if (reasoningContent) previous.reasoning_content = String(previous.reasoning_content ?? "") + reasoningContent;
      }
      else messages.push({ role: "assistant", content: null, tool_calls: [call], ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
      reasoningContent = undefined;
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const parts = contentParts(item.output);
      const images = parts.filter((part) => part.type === "image_url");
      const output = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      messages.push({ role: "tool", tool_call_id: text(item.call_id), content: output || (images.length ? "Image result follows." : "") });
      if (images.length) toolImages.push({ type: "text", text: "Images returned by tool call " + text(item.call_id) + ":" }, ...images);
    } else if (item.type === "message" || item.role) {
      const role = text(item.role);
      if (!["system", "developer", "user", "assistant"].includes(role)) throw new Error("Unsupported message role: " + role);
      const parts = contentParts(item.content);
      messages.push({ role: role === "developer" ? "system" : role,
        content: parts.every((part) => part.type === "text") ? parts.map((part) => part.text).join("\n") : parts,
        ...(role === "assistant" && reasoningContent ? { reasoning_content: reasoningContent } : {}) });
      if (role === "assistant") reasoningContent = undefined;
    } else throw new Error("Unsupported Responses input item: " + String(item.type));
  }
  flushToolImages();
  let toolChoice = request.tool_choice;
  if (toolChoice && typeof toolChoice === "object") {
    const choice = object(toolChoice);
    if (choice.type !== "function" && choice.type !== "custom") throw new Error("Unsupported tool_choice");
    toolChoice = { type: "function", function: { name: text(choice.name) } };
  }
  const body: JsonObject = { model: text(request.model), messages, stream: true, stream_options: { include_usage: true } };
  if (chatTools.length) body.tools = chatTools;
  if (toolChoice !== undefined) body.tool_choice = toolChoice;
  for (const key of ["temperature", "top_p", "parallel_tool_calls"]) if (request[key] !== undefined) body[key] = request[key];
  if (request.max_output_tokens !== undefined) body.max_completion_tokens = request.max_output_tokens;
  if (request.reasoning) {
    const reasoning = object(request.reasoning);
    if (reasoning.effort !== undefined) body.reasoning_effort = reasoning.effort;
  }
  if (request.text) {
    const format = object(request.text).format;
    if (format && object(format).type !== "text") {
      const f = object(format);
      if (f.type === "json_object") body.response_format = { type: "json_object" };
      else if (f.type === "json_schema") body.response_format = { type: "json_schema", json_schema: { name: f.name, schema: f.schema, strict: f.strict } };
      else throw new Error("Unsupported output format");
    }
  }
  return { body, customTools };
}

export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let data: string[] = [];
  let dataLength = 0;
  try {
    for (;;) {
      const result = await reader.read();
      pending += decoder.decode(result.value, { stream: !result.done });
      if (pending.length > 32 * 1024 * 1024) throw new Error("Upstream SSE event too large");
      let index: number;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index).replace(/\r$/, "");
        pending = pending.slice(index + 1);
        if (!line) { if (data.length) yield data.join("\n"); data = []; dataLength = 0; }
        else if (line.startsWith("data:")) {
          dataLength += line.length;
          if (dataLength > 32 * 1024 * 1024) throw new Error("Upstream SSE event too large");
          data.push(line.slice(5).replace(/^ /, ""));
        }
      }
      if (result.done) {
        if (pending.startsWith("data:")) data.push(pending.slice(5).replace(/^ /, ""));
        if (data.length) yield data.join("\n");
        break;
      }
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export async function chatToResponses(
  body: ReadableStream<Uint8Array>, model: string, customTools: Set<string>, emit: (event: JsonObject) => void,
): Promise<JsonObject> {
  const id = "resp_" + randomUUID();
  const created = Math.floor(Date.now() / 1000);
  const output: JsonObject[] = [];
  const calls = new Map<number, { item: JsonObject; args: string; index: number; name: string; callId: string }>();
  let message: JsonObject | undefined;
  let messageText = "";
  let reasoning: JsonObject | undefined;
  let reasoningText = "";
  let usage: JsonObject = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  let sequence = 0;
  let finished: string | undefined;
  let receivedChars = 0;
  const event = (type: string, fields: JsonObject = {}) => emit({ type, sequence_number: sequence++, ...fields });
  const response = (status: string): JsonObject => ({ id, object: "response", created_at: created, model, status, output, usage, error: null, incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null });
  event("response.created", { response: { ...response("in_progress"), output: [] } });
  event("response.in_progress", { response: { ...response("in_progress"), output: [] } });
  for await (const data of sseData(body)) {
    if (data === "[DONE]") break;
    receivedChars += data.length;
    if (receivedChars > 64 * 1024 * 1024) throw new Error("Upstream completion too large");
    const chunk = object(JSON.parse(data));
    if (chunk.error) throw new Error("Upstream Chat Completions reported an error");
    if (chunk.usage) {
      const u = object(chunk.usage);
      usage = { input_tokens: u.prompt_tokens ?? 0, output_tokens: u.completion_tokens ?? 0, total_tokens: u.total_tokens ?? 0,
        input_tokens_details: { cached_tokens: u.prompt_tokens_details ? object(u.prompt_tokens_details).cached_tokens ?? 0 : 0 },
        output_tokens_details: { reasoning_tokens: u.completion_tokens_details ? object(u.completion_tokens_details).reasoning_tokens ?? 0 : 0 } };
    }
    for (const rawChoice of array(chunk.choices ?? [])) {
      const choice = object(rawChoice);
      if (choice.index !== undefined && choice.index !== 0) throw new Error("Multiple completion choices are not supported");
      if (choice.finish_reason) finished = text(choice.finish_reason);
      const delta = object(choice.delta ?? {});
      if (delta.refusal) throw new Error("Upstream model refused the request");
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
        if (!reasoning) {
          reasoning = { id: "rs_" + randomUUID(), type: "reasoning", summary: [] };
          output.push(reasoning);
          event("response.output_item.added", { output_index: output.length - 1, item: { ...reasoning } });
          event("response.reasoning_summary_part.added", { item_id: reasoning.id, output_index: output.indexOf(reasoning), summary_index: 0, part: { type: "summary_text", text: "" } });
        }
        reasoningText += delta.reasoning_content;
        event("response.reasoning_summary_text.delta", { item_id: reasoning.id, output_index: output.indexOf(reasoning), summary_index: 0, delta: delta.reasoning_content });
      }
      if (typeof delta.content === "string" && delta.content) {
        if (!message) {
          message = { id: "msg_" + randomUUID(), type: "message", role: "assistant", status: "in_progress", content: [] };
          output.push(message);
          event("response.output_item.added", { output_index: output.length - 1, item: { ...message } });
          event("response.content_part.added", { item_id: message.id, output_index: output.indexOf(message), content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        }
        messageText += delta.content;
        event("response.output_text.delta", { item_id: message.id, output_index: output.indexOf(message), content_index: 0, delta: delta.content });
      }
      for (const rawCall of array(delta.tool_calls ?? [])) {
        const call = object(rawCall);
        if (!Number.isSafeInteger(call.index)) throw new Error("Missing tool call index");
        const index = Number(call.index);
        const fn = object(call.function ?? {});
        let state = calls.get(index);
        if (!state) {
          const item: JsonObject = { id: "fc_" + randomUUID() };
          state = { item, args: "", index: output.length, name: "", callId: "" };
          calls.set(index, state);
          output.push(item);
        }
        if (fn.name !== undefined) state.name += text(fn.name);
        if (call.id !== undefined) state.callId += text(call.id);
        if (fn.arguments !== undefined) state.args += text(fn.arguments);
        if (state.args.length + state.name.length + state.callId.length > 32 * 1024 * 1024) throw new Error("Upstream tool call too large");
      }
    }
  }
  if (!finished) throw new Error("Upstream stream ended before finish_reason");
  if (!["stop", "tool_calls", "length"].includes(finished)) throw new Error("Unsupported completion finish reason: " + finished);
  if (finished === "tool_calls" && !calls.size) throw new Error("Missing tool calls");
  for (const state of calls.values()) {
    if (!state.name || !state.callId) throw new Error("Incomplete tool call identity");
    if (finished === "length") throw new Error("Truncated tool call");
    const custom = customTools.has(state.name);
    Object.assign(state.item, { type: custom ? "custom_tool_call" : "function_call", name: state.name, call_id: state.callId, status: "in_progress", [custom ? "input" : "arguments"]: "" });
    event("response.output_item.added", { output_index: state.index, item: { ...state.item } });
    const value = custom ? text(object(JSON.parse(state.args)).input) : state.args;
    if (!custom) object(JSON.parse(value));
    state.item[custom ? "input" : "arguments"] = value;
    state.item.status = "completed";
    const type = custom ? "custom_tool_call_input" : "function_call_arguments";
    event("response." + type + ".delta", { item_id: state.item.id, output_index: state.index, delta: value });
    event("response." + type + ".done", { item_id: state.item.id, output_index: state.index, [custom ? "input" : "arguments"]: value });
  }
  if (message) {
    message.status = "completed";
    const part = { type: "output_text", text: messageText, annotations: [] };
    message.content = [part];
    event("response.output_text.done", { item_id: message.id, output_index: output.indexOf(message), content_index: 0, text: messageText });
    event("response.content_part.done", { item_id: message.id, output_index: output.indexOf(message), content_index: 0, part });
  }
  if (reasoning) {
    const part = { type: "summary_text", text: reasoningText };
    reasoning.summary = [part];
    event("response.reasoning_summary_text.done", { item_id: reasoning.id, output_index: output.indexOf(reasoning), summary_index: 0, text: reasoningText });
    event("response.reasoning_summary_part.done", { item_id: reasoning.id, output_index: output.indexOf(reasoning), summary_index: 0, part });
  }
  for (const [index, item] of output.entries()) event("response.output_item.done", { output_index: index, item });
  const result = response(finished === "length" ? "incomplete" : "completed");
  event(finished === "length" ? "response.incomplete" : "response.completed", { response: result });
  return result;
}

export async function startLlmGateway(provider: GatewayProvider): Promise<{ url: string; token: string; close(): Promise<void> }> {
  if (provider.type === "anthropic") throw new Error("Codex requires an OpenAI-compatible Responses or Chat Completions endpoint; native Anthropic is not supported");
  const base = new URL(provider.baseUrl.replace(/\/$/, "") + "/");
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("Invalid provider URL");
  const token = randomBytes(32).toString("hex");
  const controllers = new Set<AbortController>();
  const server = createServer((req, res) => { void handle(req, res).catch(() => {
    if (res.headersSent) res.destroy();
    else { res.writeHead(502, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "LLM gateway request failed", type: "gateway_error" } })); }
  }); });
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.authorization !== "Bearer " + token) { res.writeHead(401); res.end(); return; }
    if (req.method !== "POST" || !["/responses", "/responses/compact"].includes(req.url ?? "")) { res.writeHead(404); res.end(); return; }
    const controller = new AbortController();
    controllers.add(controller);
    res.on("close", () => controller.abort());
    const timer = setTimeout(() => controller.abort(), 10 * 60_000);
    try {
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        length += buffer.length;
        if (length > 32 * 1024 * 1024) { res.writeHead(413); res.end(); return; }
        chunks.push(buffer);
      }
      let request: JsonObject;
      let translated: ReturnType<typeof responsesToChat> | undefined;
      try {
        request = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        // Codex accepts xhigh internally; preserve a configured upstream max effort.
        if (provider.reasoningEffort) request.reasoning = { ...object(request.reasoning ?? {}), effort: provider.reasoningEffort };
        if ((provider.wireApi ?? "completions") === "completions") {
          if (req.url !== "/responses") throw new Error("Remote compaction requires a native Responses endpoint");
          translated = responsesToChat(request);
        }
      } catch (error) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : "Invalid request", type: "invalid_request_error" } })); return;
      }
      const url = new URL(translated ? "chat/completions" : req.url!.slice(1), base);
      const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
      if (provider.apiKey) headers[provider.type === "azure" ? "api-key" : "authorization"] = provider.type === "azure" ? provider.apiKey : "Bearer " + provider.apiKey;
      if (provider.type === "azure") url.searchParams.set("api-version", provider.azure?.apiVersion ?? "2024-10-21");
      const upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(translated?.body ?? request), signal: controller.signal, redirect: "error" });
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel();
        res.writeHead(upstream.ok ? 502 : upstream.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Upstream LLM returned HTTP " + upstream.status, type: "upstream_error" } })); return;
      }
      if (!translated) {
        res.writeHead(200, { "content-type": upstream.headers.get("content-type") ?? "text/event-stream", "cache-control": "no-cache" });
        for await (const chunk of upstream.body) {
          if (!res.write(chunk)) await new Promise<void>((resolve, reject) => {
            const close = () => { res.off("drain", drain); reject(new Error("Client disconnected")); };
            const drain = () => { res.off("close", close); resolve(); };
            res.once("drain", drain); res.once("close", close);
          });
        }
        res.end(); return;
      }
      const streaming = request.stream === true;
      if (streaming) res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      try {
        const result = await chatToResponses(upstream.body, text(request.model), translated.customTools, (event) => {
          if (streaming) {
            res.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n");
            if (res.writableLength > 8 * 1024 * 1024) throw new Error("Gateway client is too slow");
          }
        });
        if (!streaming) { res.writeHead(200, { "content-type": "application/json" }); res.write(JSON.stringify(result)); }
        res.end();
      } catch {
        if (streaming && !res.destroyed) { res.write('event: error\ndata: {"type":"error","code":"gateway_error","message":"Invalid or interrupted upstream completion"}\n\n'); res.end(); }
        else throw new Error("Invalid upstream completion");
      }
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Gateway did not bind TCP");
  return { url: "http://127.0.0.1:" + address.port, token, close: async () => {
    for (const controller of controllers) controller.abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}
