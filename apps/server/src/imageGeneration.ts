import type { ModelProviderConfig } from "@cca/protocol";

export interface ImageGenerationProvider {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** Codex 0.156 exposes the built-in image_gen tool when this header is present on a custom provider. */
export const CODEX_IMAGE_ACTOR_HEADER = "x-openai-actor-authorization";
export const CODEX_IMAGE_ACTOR_VALUE = "cca-image-extension";

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
