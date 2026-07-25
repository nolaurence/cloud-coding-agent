import assert from "node:assert/strict";
import test from "node:test";
import { buildProviderModelsUrl, discoverProviderModels } from "./providers.js";

test("buildProviderModelsUrl appends models to the base path", () => {
  assert.equal(buildProviderModelsUrl("https://example.com/v1").href, "https://example.com/v1/models");
  assert.equal(buildProviderModelsUrl("https://example.com/v1/").href, "https://example.com/v1/models");
  assert.throws(() => buildProviderModelsUrl("ftp://example.com/v1"), /仅支持 HTTP 或 HTTPS/);
  assert.throws(() => buildProviderModelsUrl("https://user:pass@example.com/v1"), /不能包含用户名或密码/);
});

test("discoverProviderModels sends auth and filters, names, deduplicates, and sorts models", async () => {
  let requestedUrl = "";
  let authorization = "";
  const models = await discoverProviderModels(
    { type: "openai", baseUrl: "https://example.com/v1", apiKey: "secret" },
    async (input, init) => {
      requestedUrl = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(
        JSON.stringify({
          data: [
            { id: "z-model", name: "Zed" },
            { id: "a-model", display_name: "Alpha" },
            { id: "z-model", name: "Duplicate" },
            { name: "Missing id" },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );

  assert.equal(requestedUrl, "https://example.com/v1/models");
  assert.equal(authorization, "Bearer secret");
  assert.deepEqual(models, [
    { id: "a-model", name: "Alpha" },
    { id: "z-model", name: "Zed" },
  ]);
});

test("discoverProviderModels allows providers without an API key", async () => {
  let authorization: string | null = "unexpected";
  await discoverProviderModels({ type: "openai", baseUrl: "http://localhost:11434/v1" }, async (_input, init) => {
    authorization = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({ data: [{ id: "local-model" }] }), { status: 200 });
  });
  assert.equal(authorization, null);
});

test("discoverProviderModels reports service errors without leaking the API key", async () => {
  const apiKey = "top-secret-key";
  await assert.rejects(
    discoverProviderModels({ type: "openai", baseUrl: "https://example.com/v1", apiKey }, async () => {
      return new Response(JSON.stringify({ error: { message: `invalid key ${apiKey}` } }), { status: 401 });
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HTTP 401/);
      assert.match(error.message, /\[已隐藏\]/);
      assert.ok(!error.message.includes(apiKey));
      return true;
    },
  );
});

test("discoverProviderModels rejects unsupported and empty responses", async () => {
  await assert.rejects(
    discoverProviderModels({ type: "anthropic", baseUrl: "https://api.anthropic.com/v1" }, async () => {
      throw new Error("fetch should not run");
    }),
    /仅支持自动获取 OpenAI 兼容服务/,
  );
  await assert.rejects(
    discoverProviderModels({ type: "openai", baseUrl: "https://example.com/v1" }, async () => {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }),
    /没有返回可用模型/,
  );
});
