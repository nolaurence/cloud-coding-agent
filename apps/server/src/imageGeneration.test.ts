import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProviderConfig } from "@cca/protocol";
import { gptImageModelRank, selectImageGenerationProvider } from "./imageGeneration.js";

const provider = (id: string, models: string[], type: ModelProviderConfig["type"] = "openai"): ModelProviderConfig => ({
  id, name: id, type, baseUrl: `https://${id}.example/v1`, apiKey: id + "-key", models: models.map((model) => ({ id: model })),
});

test("ranks GPT Image 2.6 ahead of 1.x/2 models that reject injected complexity", () => {
  assert.ok(gptImageModelRank("gpt-image-2.6-sunburst") < gptImageModelRank("gpt-image-2"));
  assert.ok(gptImageModelRank("gpt-image-2") < gptImageModelRank("gpt-image-1.5"));
  assert.ok(gptImageModelRank("gpt-image-1.5") < gptImageModelRank("gpt-image-1"));
});

test("selects the preferred OpenAI GPT Image model before later providers", () => {
  assert.deepEqual(selectImageGenerationProvider([
    provider("chat", ["gpt-5.4"]),
    provider("images", ["gpt-image-1.5"]),
  ], "chat"), { baseUrl: "https://images.example/v1", apiKey: "images-key", model: "gpt-image-1.5" });
  assert.deepEqual(selectImageGenerationProvider([
    provider("chat", ["gpt-5.4", "gpt-image-1"]),
    provider("images", ["gpt-image-1.5"]),
  ], "chat"), { baseUrl: "https://images.example/v1", apiKey: "images-key", model: "gpt-image-1.5" });
});

test("prefers a GPT Image 2.6 model even when a 1.5 id is listed first", () => {
  assert.deepEqual(selectImageGenerationProvider([
    provider("chat", ["gpt-5.4", "gpt-image-1.5"]),
    provider("images", ["gpt-image-2.6-flare"]),
  ], "chat"), {
    baseUrl: "https://images.example/v1",
    apiKey: "images-key",
    model: "gpt-image-2.6-flare",
  });
  assert.deepEqual(selectImageGenerationProvider([
    provider("chat", ["gpt-image-1.5", "gpt-image-2.6-sunburst"]),
  ], "chat"), {
    baseUrl: "https://chat.example/v1",
    apiKey: "chat-key",
    model: "gpt-image-2.6-sunburst",
  });
});

test("exposes a complexity-capable model for gateway retry when 2.6 is not selected first", () => {
  assert.deepEqual(selectImageGenerationProvider([
    provider("images", ["gpt-image-1.5", "gpt-image-2"]),
  ], "images"), { baseUrl: "https://images.example/v1", apiKey: "images-key", model: "gpt-image-2" });
  assert.deepEqual(selectImageGenerationProvider([
    provider("images", ["gpt-image-1.5"]),
    provider("images26", ["gpt-image-2.6-sunburst"]),
  ], "images"), {
    baseUrl: "https://images26.example/v1",
    apiKey: "images26-key",
    model: "gpt-image-2.6-sunburst",
  });
});

test("ignores similarly named models and non-OpenAI providers", () => {
  assert.equal(selectImageGenerationProvider([
    provider("chat", ["not-gpt-image-1"]),
    provider("claude", ["gpt-image-1.5"], "anthropic"),
  ], "chat"), undefined);
});
