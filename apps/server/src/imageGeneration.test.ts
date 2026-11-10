import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProviderConfig } from "@cca/protocol";
import { selectImageGenerationProvider } from "./imageGeneration.js";

const provider = (id: string, models: string[], type: ModelProviderConfig["type"] = "openai"): ModelProviderConfig => ({
  id, name: id, type, baseUrl: `https://${id}.example/v1`, apiKey: id + "-key", models: models.map((model) => ({ id: model })),
});

test("selects the preferred OpenAI GPT Image model before later providers", () => {
  assert.deepEqual(selectImageGenerationProvider([
    provider("chat", ["gpt-5.4"]),
    provider("images", ["gpt-image-1.5"]),
  ], "chat"), { baseUrl: "https://images.example/v1", apiKey: "images-key", model: "gpt-image-1.5" });
  assert.deepEqual(selectImageGenerationProvider([
    provider("chat", ["gpt-5.4", "gpt-image-1"]),
    provider("images", ["gpt-image-1.5"]),
  ], "chat"), { baseUrl: "https://chat.example/v1", apiKey: "chat-key", model: "gpt-image-1" });
});

test("ignores similarly named models and non-OpenAI providers", () => {
  assert.equal(selectImageGenerationProvider([
    provider("chat", ["not-gpt-image-1"]),
    provider("claude", ["gpt-image-1.5"], "anthropic"),
  ], "chat"), undefined);
});
