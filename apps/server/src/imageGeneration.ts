import type { ModelProviderConfig } from "@cca/protocol";

export interface ImageGenerationProvider {
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** GPT Image 2.6 id to retry with when a 1.x/2 proxy injects complexity. */
  complexityModel?: string;
}

/** Codex 0.167 exposes the built-in image_gen tool when this header is present on a custom provider. */
export const CODEX_IMAGE_ACTOR_HEADER = "x-openai-actor-authorization";
export const CODEX_IMAGE_ACTOR_VALUE = "cca-image-extension";
export const DEFAULT_COMPLEXITY_IMAGE_MODEL = "gpt-image-2.6-sunburst";

export function isGptImageModel(id: string): boolean {
  return /^gpt-image(?:-|$)/i.test(id.trim());
}

export function isComplexityImageModel(id: string): boolean {
  return /gpt-image-2\.6(?:-|$)/i.test(id.trim());
}

/** Lower is better: 2.6 (accepts complexity) before 2.5, 2, 1.5, then other gpt-image ids. */
export function gptImageModelRank(id: string): number {
  const model = id.trim();
  if (isComplexityImageModel(model)) return 0;
  if (/gpt-image-2\.[5-9]/i.test(model)) return 1;
  if (/^gpt-image-2(?:-|$)/i.test(model)) return 2;
  if (/gpt-image-1\.5/i.test(model)) return 3;
  if (/^gpt-image-1(?:-|$)/i.test(model)) return 4;
  return 5;
}

export function selectImageGenerationProvider(
  providers: readonly ModelProviderConfig[],
  preferredProviderId: string,
): ImageGenerationProvider | undefined {
  const eligible = providers.filter((provider) => provider.type === "openai");
  const preferred = eligible.find((provider) => provider.id === preferredProviderId);
  const ordered = preferred ? [preferred, ...eligible.filter((entry) => entry !== preferred)] : eligible;
  const candidates: { provider: ModelProviderConfig; model: string; rank: number; order: number }[] = [];
  let order = 0;
  for (const provider of ordered) {
    for (const entry of provider.models) {
      const model = entry.id.trim();
      if (!isGptImageModel(model)) continue;
      candidates.push({ provider, model, rank: gptImageModelRank(model), order: order++ });
    }
  }
  candidates.sort((left, right) => left.rank - right.rank || left.order - right.order);
  const best = candidates[0];
  if (!best) return;
  const complexityModel = candidates.find((candidate) => candidate.rank === 0)?.model;
  return {
    baseUrl: best.provider.baseUrl.trim(),
    apiKey: best.provider.apiKey?.trim() || undefined,
    model: best.model,
    ...(complexityModel && complexityModel !== best.model ? { complexityModel } : {}),
  };
}
