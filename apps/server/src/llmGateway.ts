import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { DEFAULT_COMPLEXITY_IMAGE_MODEL, isComplexityImageModel } from "./imageGeneration.js";

export { DEFAULT_COMPLEXITY_IMAGE_MODEL };

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
  imageGenerationModel?: string;
  imageGenerationComplexityModel?: string;
  imageGenerationBaseUrl?: string;
  imageGenerationApiKey?: string;
}

function requestPath(url: string | undefined): string {
  return (url ?? "").split("?")[0] ?? "";
}

function imageApiBase(provider: GatewayProvider): URL {
  const base = new URL((provider.imageGenerationBaseUrl ?? provider.baseUrl).replace(/\/+$/, "") + "/");
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("生图提供商地址无效");
  return base;
}

function imageApiHeaders(provider: GatewayProvider, accept: string, contentType?: string): Record<string, string> {
  const headers: Record<string, string> = { accept };
  if (contentType) headers["content-type"] = contentType;
  const apiKey = provider.imageGenerationApiKey ?? provider.apiKey;
  if (apiKey) headers[provider.type === "azure" ? "api-key" : "authorization"] = provider.type === "azure" ? apiKey : "Bearer " + apiKey;
  return headers;
}

function configuredImageModel(provider: GatewayProvider): string | undefined {
  const model = provider.imageGenerationModel?.trim();
  return model && /^gpt-image(?:-|$)/i.test(model) ? model : undefined;
}

const IMAGE_REQUEST_FIELDS = new Set([
  "prompt", "model", "n", "size", "quality", "background",
  "output_format", "output_compression", "moderation", "user",
  "partial_images", "stream", "image", "images", "mask", "input_fidelity",
]);
const EXTENDED_QUALITY_IMAGE_MODEL = /gpt-image-2\.[5-9]/i;
const BASE_IMAGE_QUALITY = new Set(["low", "medium", "high", "auto"]);
const EXTENDED_IMAGE_QUALITY = new Set(["low", "medium", "high", "auto", "xhigh", "max"]);

const IMAGE_COMPAT_FIELDS = ["prompt", "model", "n", "image", "images", "mask"] as const;
const IMAGE_AUTO_FIELDS = ["quality", "size", "background"] as const;
const IMAGE_PARAM_IN_MESSAGE = /\b(complexity|quality|size|background|output_format|output_compression|moderation|style)\b/i;

/** Codex 0.167 image_gen.imagegen always posts this JSON, even when the tool caller only sent prompt + transparent_background. */
export function codexImagegenHttpBody(prompt: string, transparentBackground = false): JsonObject {
  return {
    prompt,
    background: transparentBackground ? "transparent" : "opaque",
    model: "gpt-image-2",
    quality: "auto",
    size: "auto",
  };
}

/** Drop Codex/OpenAI fields the configured GPT Image model cannot accept (e.g. complexity on 1.x/2). */
export function sanitizeCodexImageRequest(model: string, payload: JsonObject): JsonObject {
  const next: JsonObject = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value == null || !IMAGE_REQUEST_FIELDS.has(key)) continue;
    next[key] = value;
  }
  next.model = model;
  if (payload.transparent_background === true) next.background = "transparent";
  else if (payload.transparent_background === false) delete next.background;
  const supportsComplexity = isComplexityImageModel(model);
  if (supportsComplexity) {
    if (payload.complexity === "low" || payload.complexity === "medium" || payload.complexity === "high") {
      next.complexity = payload.complexity;
    }
    for (const key of ["frame_count", "frame_duration_ms", "markup"] as const) {
      if (payload[key] != null) next[key] = payload[key];
    }
  }
  if (typeof next.quality === "string") {
    const allowed = EXTENDED_QUALITY_IMAGE_MODEL.test(model) ? EXTENDED_IMAGE_QUALITY : BASE_IMAGE_QUALITY;
    if (!allowed.has(next.quality)) delete next.quality;
  }
  // Codex 0.167 imagegen maps transparent_background:false to background:"opaque" and
  // always sends quality/size "auto". It never sends complexity. Compatible 1.x/2
  // proxies treat those extras as a GPT Image 2.6 request and inject complexity:"medium".
  if (!supportsComplexity) {
    for (const key of IMAGE_AUTO_FIELDS) if (next[key] === "auto") delete next[key];
    if (next.background === "opaque") delete next.background;
  }
  return next;
}

/** Keep only fields the original custom image MCP used, for a last-resort retry. */
export function compactCodexImageRequest(payload: JsonObject): JsonObject | undefined {
  const next: JsonObject = {};
  for (const key of IMAGE_COMPAT_FIELDS) if (payload[key] != null) next[key] = payload[key];
  if (payload.background === "transparent") next.background = "transparent";
  if (next.prompt == null && next.image == null && next.images == null) return;
  return Object.keys(payload).some((key) => !(key in next)) ? next : undefined;
}

/**
 * Production 1.x/2 proxies inject complexity:"medium" even after extras are stripped.
 * Retry on a GPT Image 2.6 model that legally accepts that field.
 */
export function complexityCompatibleRetry(
  currentModel: string,
  inbound: JsonObject,
  status: number,
  body: Buffer,
  preferredComplexityModel?: string,
): JsonObject | undefined {
  if (unsupportedImageRequestParam(status, body) !== "complexity") return;
  if (isComplexityImageModel(currentModel)) return;
  const nextModel = preferredComplexityModel?.trim() && isComplexityImageModel(preferredComplexityModel.trim())
    ? preferredComplexityModel.trim()
    : DEFAULT_COMPLEXITY_IMAGE_MODEL;
  if (nextModel === currentModel) return;
  const next = sanitizeCodexImageRequest(nextModel, inbound);
  if (next.complexity == null) next.complexity = "medium";
  return next;
}

/** Surface the model actually sent upstream so a 400 can be diagnosed. */
export function annotateImageError(status: number, contentType: string, body: Buffer, model: string): Buffer {
  if (status < 400 || !contentType.includes("json") || !model) return body;
  try {
    const payload = object(JSON.parse(body.toString("utf8")));
    const error = payload.error && typeof payload.error === "object" && !Array.isArray(payload.error) ? object(payload.error) : payload;
    const message = String(error.message ?? error.msg ?? "");
    if (message && !message.includes(model)) error.message = message.replace(/\s*$/, "") + `（实际模型：${model}）`;
    error.model = model;
    if (payload.error) payload.error = error;
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return body;
  }
}

export function unsupportedImageRequestParam(status: number, body: Buffer): string | undefined {
  if (status < 400) return;
  try {
    const parsed = object(JSON.parse(body.toString("utf8")));
    const error = parsed.error && typeof parsed.error === "object" && !Array.isArray(parsed.error) ? object(parsed.error) : parsed;
    if (typeof error.param === "string" && error.param && error.param !== "model" && error.param !== "prompt") return error.param;
    const message = String(error.message ?? error.msg ?? "");
    const quoted = message.match(/^([A-Za-z_][A-Za-z0-9_]*) '/);
    if (quoted?.[1] && quoted[1] !== "Model" && quoted[1] !== "Prompt") {
      return quoted[1].charAt(0).toLowerCase() + quoted[1].slice(1).replaceAll(/[A-Z]/g, (letter) => "_" + letter.toLowerCase());
    }
    const named = message.match(IMAGE_PARAM_IN_MESSAGE)?.[1];
    if (named) return named.toLowerCase();
  } catch {
    return;
  }
}

/** Codex 0.167 ImagesClient requires ImageResponse.created; some GPT Image proxies omit it. */
export function normalizeCodexImageResponse(status: number, contentType: string, body: Buffer): Buffer {
  if (status >= 400 || !contentType.includes("json")) return body;
  try {
    const payload = object(JSON.parse(body.toString("utf8")));
    if (typeof payload.created !== "number") payload.created = Math.floor(Date.now() / 1000);
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return body;
  }
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

interface ToolTranslation {
  toolSearch: boolean;
  toolNames: Map<string, { name: string; namespace: string }>;
}

export function responsesToChat(request: JsonObject): { body: JsonObject; customTools: Set<string>; imageGeneration: boolean } & ToolTranslation {
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
  const tools = [...array(request.tools ?? [])];
  const toolSearch = tools.some((raw) => object(raw).type === "tool_search");
  if (toolSearch) for (const raw of input) {
    const item = object(raw);
    if (item.type === "tool_search_output") tools.push(...array(item.tools ?? []));
  }
  const customTools = new Set<string>();
  const toolNames: ToolTranslation["toolNames"] = new Map();
  const callableName = (name: string, namespace?: string) => namespace ? namespace + "__" + name : name;
  let imageGeneration = false;
  const translateTools = (items: unknown[], namespace?: string): JsonObject[] => items.flatMap<JsonObject>((raw): JsonObject | JsonObject[] => {
    const tool = object(raw);
    if (tool.type === "namespace") return translateTools(array(tool.tools), text(tool.name));
    if (tool.type === "tool_search") {
      if (tool.execution !== "client") throw new Error("Hosted tool search is not supported by Chat Completions");
      return { type: "function", function: { name: "tool_search", description: tool.description, parameters: tool.parameters } };
    }
    if (tool.type === "function" || tool.type === "custom") text(tool.name);
    const name = typeof tool.name === "string" ? callableName(tool.name, namespace) : "";
    if (namespace && name) toolNames.set(name, { name: text(tool.name), namespace });
    if (tool.type === "function") return { type: "function", function: {
      name, description: tool.description, parameters: tool.parameters ?? { type: "object", properties: {} },
      ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
    } };
    if (tool.type === "image_generation") {
      imageGeneration = true;
      return { type: "function", function: {
        name: "image_generation",
        description: "Generate a new image with GPT Image. Provide a complete, detailed prompt for the requested image.",
        parameters: { type: "object", properties: { prompt: { type: "string" } }, required: ["prompt"], additionalProperties: false },
      } };
    }
    if (tool.type === "custom") {
      customTools.add(name);
      return { type: "function", function: { name,
        description: String(tool.description ?? "") + "\nThis compatibility API exposes a JSON function, overriding freeform transport instructions above. Put the complete raw tool input in the input string; never put JSON wrappers or Markdown fences inside that string.",
        parameters: { type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false },
      } };
    }
    throw new Error("Unsupported Responses tool: " + String(tool.type));
  });
  const chatTools = [...new Map(translateTools(tools).map((tool) => [object(tool.function).name, tool])).values()];
  for (const raw of input) {
    const item = object(raw);
    if (item.type !== "function_call_output" && item.type !== "custom_tool_call_output") flushToolImages();
    if (item.type === "reasoning") {
      const summary = array(item.summary ?? []).map(object).filter((part) => part.type === "summary_text").map((part) => text(part.text)).join("\n");
      if (summary) reasoningContent = (reasoningContent ?? "") + summary;
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call" || item.type === "tool_search_call") {
      const call = { id: text(item.call_id), type: "function", function: { name: item.type === "tool_search_call" ? "tool_search" : callableName(text(item.name), typeof item.namespace === "string" ? item.namespace : undefined),
        arguments: item.type === "custom_tool_call" ? JSON.stringify({ input: text(item.input) }) : item.type === "tool_search_call" ? JSON.stringify(item.arguments) : text(item.arguments) } };
      const previous = messages.at(-1);
      if (previous?.role === "assistant") {
        previous.tool_calls = [...array(previous.tool_calls ?? []), call];
        if (reasoningContent) previous.reasoning_content = String(previous.reasoning_content ?? "") + reasoningContent;
      }
      else messages.push({ role: "assistant", content: null, tool_calls: [call], ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) });
      reasoningContent = undefined;
    } else if (item.type === "tool_search_output") {
      messages.push({ role: "tool", tool_call_id: text(item.call_id), content: JSON.stringify({ tools: item.tools }) });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const parts = contentParts(item.output);
      const images = parts.filter((part) => part.type === "image_url");
      const output = parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      messages.push({ role: "tool", tool_call_id: text(item.call_id), content: output || (images.length ? "Image result follows." : "") });
      if (images.length) toolImages.push({ type: "text", text: "Images returned by tool call " + text(item.call_id) + ":" }, ...images);
    } else if (item.type === "image_generation_call") {
      const caption = typeof item.revised_prompt === "string" ? item.revised_prompt : "Image generated by the assistant.";
      messages.push({ role: "assistant", content: caption });
      if (typeof item.result === "string" && item.result) {
        messages.push({ role: "user", content: [
          { type: "text", text: "Image generated by the assistant:" },
          { type: "image_url", image_url: { url: "data:image/" + (item.output_format === "jpeg" ? "jpeg" : item.output_format === "webp" ? "webp" : "png") + ";base64," + item.result } },
        ] });
      }
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
    if (!["function", "custom", "image_generation", "tool_search"].includes(String(choice.type))) throw new Error("Unsupported tool_choice");
    toolChoice = { type: "function", function: { name: choice.type === "image_generation" || choice.type === "tool_search" ? choice.type : callableName(text(choice.name), typeof choice.namespace === "string" ? choice.namespace : undefined) } };
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
  return { body, customTools, imageGeneration, toolSearch, toolNames };
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
  body: ReadableStream<Uint8Array>, model: string, customTools: Set<string>, emit: (event: JsonObject) => unknown,
  generateImage?: (argumentsValue: JsonObject) => Promise<JsonObject>,
  toolTranslation?: ToolTranslation,
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
  const event = async (type: string, fields: JsonObject = {}) => { await emit({ type, sequence_number: sequence++, ...fields }); };
  const response = (status: string): JsonObject => ({ id, object: "response", created_at: created, model, status, output, usage, error: null, incomplete_details: status === "incomplete" ? { reason: "max_output_tokens" } : null });
  await event("response.created", { response: { ...response("in_progress"), output: [] } });
  await event("response.in_progress", { response: { ...response("in_progress"), output: [] } });
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
          await event("response.output_item.added", { output_index: output.length - 1, item: { ...reasoning } });
          await event("response.reasoning_summary_part.added", { item_id: reasoning.id, output_index: output.indexOf(reasoning), summary_index: 0, part: { type: "summary_text", text: "" } });
        }
        reasoningText += delta.reasoning_content;
        await event("response.reasoning_summary_text.delta", { item_id: reasoning.id, output_index: output.indexOf(reasoning), summary_index: 0, delta: delta.reasoning_content });
      }
      if (typeof delta.content === "string" && delta.content) {
        if (!message) {
          message = { id: "msg_" + randomUUID(), type: "message", role: "assistant", status: "in_progress", content: [] };
          output.push(message);
          await event("response.output_item.added", { output_index: output.length - 1, item: { ...message } });
          await event("response.content_part.added", { item_id: message.id, output_index: output.indexOf(message), content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        }
        messageText += delta.content;
        await event("response.output_text.delta", { item_id: message.id, output_index: output.indexOf(message), content_index: 0, delta: delta.content });
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
    if (state.name === "image_generation" && generateImage) {
      Object.assign(state.item, { id: "ig_" + randomUUID(), type: "image_generation_call", status: "in_progress", result: "" });
      await event("response.output_item.added", { output_index: state.index, item: { ...state.item } });
      await event("response.image_generation_call.in_progress", { item_id: state.item.id, output_index: state.index });
      Object.assign(state.item, await generateImage(object(JSON.parse(state.args))), { status: "completed" });
      await event("response.image_generation_call.completed", { item_id: state.item.id, output_index: state.index });
      continue;
    }
    if (state.name === "tool_search" && toolTranslation?.toolSearch) {
      Object.assign(state.item, { type: "tool_search_call", execution: "client", call_id: state.callId, status: "in_progress", arguments: {} });
      await event("response.output_item.added", { output_index: state.index, item: { ...state.item } });
      Object.assign(state.item, { status: "completed", arguments: object(JSON.parse(state.args)) });
      continue;
    }
    const custom = customTools.has(state.name);
    const original = toolTranslation?.toolNames.get(state.name);
    Object.assign(state.item, { type: custom ? "custom_tool_call" : "function_call", name: original?.name ?? state.name, ...(original ? { namespace: original.namespace } : {}), call_id: state.callId, status: "in_progress", [custom ? "input" : "arguments"]: "" });
    await event("response.output_item.added", { output_index: state.index, item: { ...state.item } });
    const value = custom ? text(object(JSON.parse(state.args)).input) : state.args;
    if (!custom) object(JSON.parse(value));
    state.item[custom ? "input" : "arguments"] = value;
    state.item.status = "completed";
    const type = custom ? "custom_tool_call_input" : "function_call_arguments";
    await event("response." + type + ".delta", { item_id: state.item.id, output_index: state.index, delta: value });
    await event("response." + type + ".done", { item_id: state.item.id, output_index: state.index, [custom ? "input" : "arguments"]: value });
  }
  if (message) {
    message.status = "completed";
    const part = { type: "output_text", text: messageText, annotations: [] };
    message.content = [part];
    await event("response.output_text.done", { item_id: message.id, output_index: output.indexOf(message), content_index: 0, text: messageText });
    await event("response.content_part.done", { item_id: message.id, output_index: output.indexOf(message), content_index: 0, part });
  }
  if (reasoning) {
    const part = { type: "summary_text", text: reasoningText };
    reasoning.summary = [part];
    await event("response.reasoning_summary_text.done", { item_id: reasoning.id, output_index: output.indexOf(reasoning), summary_index: 0, text: reasoningText });
    await event("response.reasoning_summary_part.done", { item_id: reasoning.id, output_index: output.indexOf(reasoning), summary_index: 0, part });
  }
  for (const [index, item] of output.entries()) await event("response.output_item.done", { output_index: index, item });
  const result = response(finished === "length" ? "incomplete" : "completed");
  await event(finished === "length" ? "response.incomplete" : "response.completed", { response: result });
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
  async function proxyImages(req: IncomingMessage, res: ServerResponse, route: "images/generations" | "images/edits", body: Buffer, signal: AbortSignal) {
    const model = configuredImageModel(provider);
    if (provider.type !== "openai" || !model) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "当前提供商未配置 GPT Image 模型", type: "invalid_request_error" } }));
      return;
    }
    const contentType = String(req.headers["content-type"] ?? "application/json");
    let inbound: JsonObject | undefined;
    let payload: JsonObject | undefined;
    let upstreamBody = body;
    if (contentType.includes("application/json")) {
      inbound = object(JSON.parse(body.toString("utf8")));
      payload = sanitizeCodexImageRequest(model, inbound);
      upstreamBody = Buffer.from(JSON.stringify(payload));
    }
    const url = new URL(route, imageApiBase(provider));
    const forward = (requestBody: Buffer) => fetch(url, {
      method: "POST",
      headers: imageApiHeaders(provider, "application/json", contentType),
      body: new Uint8Array(requestBody),
      signal,
      redirect: "error",
    });
    let upstream = await forward(upstreamBody);
    let responseBody = Buffer.from(await upstream.arrayBuffer());
    if (payload && upstream.status >= 400) {
      const param = unsupportedImageRequestParam(upstream.status, responseBody);
      if (param && param in payload && param !== "model" && param !== "prompt") {
        delete payload[param];
        upstream = await forward(Buffer.from(JSON.stringify(payload)));
        responseBody = Buffer.from(await upstream.arrayBuffer());
      }
      // Production proxies inject complexity after our rewrite. The inbound Codex body
      // never contains that field, so deleting error.param is a no-op — fall back to the
      // pre-native MCP shape ({model, prompt, n, ...}).
      if (upstream.status >= 400) {
        const compact = compactCodexImageRequest(payload);
        if (compact) {
          payload = compact;
          upstream = await forward(Buffer.from(JSON.stringify(payload)));
          responseBody = Buffer.from(await upstream.arrayBuffer());
        }
      }
      if (upstream.status >= 400 && inbound) {
        const retry = complexityCompatibleRetry(
          String(payload.model ?? model),
          inbound,
          upstream.status,
          responseBody,
          provider.imageGenerationComplexityModel,
        );
        if (retry) {
          payload = retry;
          upstream = await forward(Buffer.from(JSON.stringify(payload)));
          responseBody = Buffer.from(await upstream.arrayBuffer());
        }
      }
    }
    const contentTypeHeader = upstream.headers.get("content-type") ?? "application/json";
    const outboundModel = String(payload?.model ?? model);
    res.writeHead(upstream.status, { "content-type": contentTypeHeader });
    res.end(annotateImageError(upstream.status, contentTypeHeader, normalizeCodexImageResponse(upstream.status, contentTypeHeader, responseBody), outboundModel));
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.authorization !== "Bearer " + token) { res.writeHead(401); res.end(); return; }
    const pathName = requestPath(req.url);
    if (req.method !== "POST" || !["/responses", "/responses/compact", "/images/generations", "/images/edits", "/v1/images/generations", "/v1/images/edits"].includes(pathName)) {
      res.writeHead(404); res.end(); return;
    }
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
      const rawBody = Buffer.concat(chunks);
      if (pathName.endsWith("/images/generations") || pathName.endsWith("/images/edits")) {
        await proxyImages(req, res, pathName.endsWith("/images/edits") ? "images/edits" : "images/generations", rawBody, controller.signal);
        return;
      }
      let request: JsonObject;
      let translated: ReturnType<typeof responsesToChat> | undefined;
      try {
        request = object(JSON.parse(rawBody.toString("utf8")));
        if (Array.isArray(request.tools)) {
          // Codex's standalone image_gen calls /images/generations on this gateway.
          // Do not forward hosted Responses image_generation to custom chat providers.
          request.tools = request.tools.filter((raw) => object(raw).type !== "image_generation");
        }
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
        const result = await chatToResponses(upstream.body, text(request.model), translated.customTools, async (event) => {
          if (streaming && !res.write("event: " + event.type + "\ndata: " + JSON.stringify(event) + "\n\n")) {
            await new Promise<void>((resolve, reject) => {
              const cleanup = () => { res.off("drain", drain); res.off("close", close); controller.signal.removeEventListener("abort", close); };
              const drain = () => { cleanup(); resolve(); };
              const close = () => { cleanup(); reject(new Error("Gateway client disconnected")); };
              res.once("drain", drain); res.once("close", close);
              controller.signal.addEventListener("abort", close, { once: true });
              if (controller.signal.aborted) close();
            });
          }
        }, translated.imageGeneration ? async (argumentsValue) => {
          const prompt = text(argumentsValue.prompt).trim();
          if (!prompt) throw new Error("图片提示词不能为空");
          const imageModel = configuredImageModel(provider);
          if (!imageModel) throw new Error("当前提供商未配置 GPT Image 模型");
          const imageResponse = await fetch(new URL("images/generations", imageApiBase(provider)), {
            method: "POST", headers: imageApiHeaders(provider, "application/json", "application/json"),
            body: JSON.stringify({ model: imageModel, prompt, n: 1, output_format: "png" }),
            signal: controller.signal, redirect: "error",
          });
          if (!imageResponse.ok || !imageResponse.body) {
            await imageResponse.body?.cancel();
            throw new Error("Image generation returned HTTP " + imageResponse.status);
          }
          const imageChunks: Buffer[] = [];
          let imageLength = 0;
          for await (const chunk of imageResponse.body) {
            imageLength += chunk.byteLength;
            if (imageLength > 16 * 1024 * 1024) throw new Error("Image generation response too large");
            imageChunks.push(Buffer.from(chunk));
          }
          const payload = object(JSON.parse(Buffer.concat(imageChunks).toString("utf8")));
          const image = object(array(payload.data)[0]);
          return { result: text(image.b64_json), revised_prompt: typeof image.revised_prompt === "string" ? image.revised_prompt : prompt };
        } : undefined, translated);
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
