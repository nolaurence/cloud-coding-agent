import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { ModelProviderConfig } from "@cca/protocol";
import { array, object, text, type JsonObject } from "./llmGateway.js";
import { MAX_IMAGE_SIZE } from "./uploads.js";

export interface ImageGenerationProvider {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export function selectImageGenerationProvider(
  providers: readonly ModelProviderConfig[],
  preferredProviderId: string,
): ImageGenerationProvider | undefined {
  const eligible = providers.filter((provider) => provider.type === "openai");
  const preferred = eligible.find((provider) => provider.id === preferredProviderId);
  for (const provider of preferred ? [preferred, ...eligible.filter((entry) => entry !== preferred)] : eligible) {
    const model = provider.models.find((entry) => /^gpt-image(?:-|$)/i.test(entry.id.trim()))?.id.trim();
    if (model) return { baseUrl: provider.baseUrl.trim(), apiKey: provider.apiKey?.trim() || undefined, model };
  }
  return undefined;
}

export async function generateImage(
  provider: ImageGenerationProvider,
  prompt: string,
  signal: AbortSignal,
): Promise<JsonObject> {
  if (!/^gpt-image(?:-|$)/i.test(provider.model)) throw new Error("生图提供商未配置 GPT Image 模型");
  if (!prompt.trim()) throw new Error("图片提示词不能为空");
  const base = new URL(provider.baseUrl.replace(/\/+$/, "") + "/");
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) throw new Error("生图提供商地址无效");
  const response = await fetch(new URL("images/generations", base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(provider.apiKey ? { authorization: "Bearer " + provider.apiKey } : {}),
    },
    body: JSON.stringify({ model: provider.model, prompt: prompt.trim(), n: 1, output_format: "png" }),
    signal,
    redirect: "error",
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error("生图提供商返回 HTTP " + response.status);
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.byteLength;
    if (length > Math.ceil(MAX_IMAGE_SIZE / 3) * 4 + 1024 * 1024) throw new Error("生图响应过大,单张图片不能超过 10 MB");
    chunks.push(Buffer.from(chunk));
  }
  const image = object(array(object(JSON.parse(Buffer.concat(chunks).toString("utf8"))).data)[0]);
  return { result: text(image.b64_json), revised_prompt: typeof image.revised_prompt === "string" ? image.revised_prompt : prompt };
}

// A stateless Streamable HTTP MCP endpoint lets Codex discover the tool on both
// thread/start and thread/resume. Dynamic tools cannot be added by thread/resume.
export async function startImageGenerationServer(
  provider: ImageGenerationProvider,
  onImage: (image: JsonObject) => { path: string; mimeType: string },
): Promise<{ url: string; token: string; abort(): void; close(): Promise<void> }> {
  const token = randomBytes(32).toString("hex");
  const controllers = new Map<unknown, AbortController>();
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== "Bearer " + token) { res.writeHead(401).end(); return; }
      if (req.url !== "/mcp" || req.method !== "POST") { res.writeHead(405).end(); return; }
      let length = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 64 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const request = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (request.id === undefined) {
        if (request.method === "notifications/cancelled") controllers.get(object(request.params).requestId)?.abort();
        res.writeHead(202).end();
        return;
      }
      const reply = (result: JsonObject) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      };
      if (request.method === "initialize") {
        const requestedVersion = object(request.params).protocolVersion;
        const protocolVersion = ["2025-11-25", "2025-06-18", "2025-03-26"].includes(String(requestedVersion)) ? requestedVersion : "2025-03-26";
        reply({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "cca-imagegen", version: "1.0.0" } });
      } else if (request.method === "ping") {
        reply({});
      } else if (request.method === "tools/list") {
        reply({ tools: [{
          name: "image_gen",
          description: "Generate a new image from a detailed prompt using the configured GPT Image provider. This is this session's imagegen tool. The provider credentials are already configured on the server; no OPENAI_API_KEY or CLI fallback is needed. The generated image is saved locally and automatically attached to the assistant reply. Use this tool directly for image requests. This tool generates new images; it does not edit reference images.",
          inputSchema: { type: "object", properties: { prompt: { type: "string", description: "A complete description of the requested image." } }, required: ["prompt"], additionalProperties: false },
        }] });
      } else if (request.method === "tools/call") {
        const params = object(request.params);
        if (params.name !== "image_gen") throw new Error("生图工具不存在");
        const controller = new AbortController();
        controllers.set(request.id, controller);
        const timer = setTimeout(() => controller.abort(), 10 * 60_000);
        res.on("close", () => controller.abort());
        try {
          const image = await generateImage(provider, text(object(params.arguments).prompt), controller.signal);
          controller.signal.throwIfAborted();
          const saved = onImage(image);
          reply({ content: [
            { type: "text", text: JSON.stringify({ ...saved, message: "图片已生成并自动附加到助手回复。可使用 path 将图片复制到用户指定的位置。" }) },
            { type: "image", mimeType: saved.mimeType, data: text(image.result) },
          ] });
        } catch (error) {
          reply({ isError: true, content: [{ type: "text", text: controller.signal.aborted ? "图片生成已取消" : error instanceof Error ? error.message : "图片生成失败" }] });
        } finally { clearTimeout(timer); controllers.delete(request.id); }
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }));
      }
    })().catch(() => {
      if (res.headersSent) res.destroy();
      else res.writeHead(400).end();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("生图工具服务启动失败");
  const abort = () => { for (const controller of controllers.values()) controller.abort(); };
  return { url: "http://127.0.0.1:" + address.port + "/mcp", token, abort, close: async () => {
    abort();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}
