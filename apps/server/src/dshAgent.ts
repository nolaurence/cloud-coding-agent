import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { resolveModelContextWindowTokens } from "@cca/protocol";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { DATA_DIR, WORKSPACE_ROOT } from "./env.js";
import { startLlmGateway, type GatewayProvider } from "./llmGateway.js";
import {
  apiKeyEnvName,
  isUsableDshProvider,
  providerRouteName,
  type DshGatewayRoute,
} from "./dshProfile.js";
import { store } from "./store.js";

interface RunningGateways {
  routes: DshGatewayRoute[];
  env: Record<string, string>;
  close(): Promise<void>;
}

export interface DshAgentRun {
  sessionId: string;
  finalResponse: string;
  notificationCount: number;
  eventCount: number;
}

function resolveDshBin(): string | undefined {
  const configured = process.env.DSH_BIN?.trim();
  if (configured) return configured;
  try {
    return createRequire(import.meta.url).resolve("@deepseek-ai/dsh/lib/bin.js");
  } catch {
    return undefined;
  }
}

/**
 * Build the minimal SDK-profile overlay: CCA's OpenAI-compatible gateway
 * routes, a default model, and the non-interactive approval/sandbox policy.
 * The web overlay has additional browser rows that the sdk profile does not
 * carry, so this is deliberately a separate, smaller patch.
 */
function buildSdkPatch(
  routes: readonly DshGatewayRoute[],
  cwd: string,
): { patch: unknown[]; provider: string; model: string } {
  const usable = routes.filter((route) => route.provider.models.length > 0);
  const first = usable[0];
  if (!first) throw new Error("没有可用于 SDK agent 的模型提供方");
  const preferred = store.settings.defaultModel;
  const preferredRoute = preferred
    ? usable.find((route) => route.provider.id === preferred.providerId)
    : undefined;
  const preferredModel = preferredRoute?.provider.models.find(
    (model) => model.id === preferred?.modelId,
  );
  const defaultRoute = preferredRoute && preferredModel ? preferredRoute : first;
  const defaultModel = preferredRoute && preferredModel
    ? preferredModel
    : first.provider.models[0];
  if (!defaultModel) throw new Error("模型提供方均未配置模型");

  const providers = Object.fromEntries(
    usable.map((route) => [
      route.providerName,
      {
        displayName: route.provider.name || route.provider.id,
        api: "openai-responses",
        baseURL: route.url,
        apiKeyEnv: route.apiKeyEnv,
        models: route.provider.models.map((model) => {
          const contextWindow = resolveModelContextWindowTokens(store.settings, {
            providerId: route.provider.id,
            modelId: model.id,
          });
          return {
            id: model.id,
            name: model.name?.trim() || model.id,
            ...(contextWindow ? { contextWindow } : {}),
            maxTokens: 32_768,
          };
        }),
      },
    ]),
  );

  return {
    provider: defaultRoute.providerName,
    model: defaultModel.id,
    patch: [
      { id: "llm-pi-ai", config: { providers } },
      {
        id: "agent-default-model",
        config: { provider: defaultRoute.providerName, model: defaultModel.id },
      },
      {
        id: "sandbox-policy",
        config: { mode: "danger-full-access", workspaceRoot: cwd },
      },
      { id: "approval", config: { policy: "never" } },
      {
        id: "permission",
        config: {
          defaultPreset: "danger-full-access",
          presets: {
            "read-only": { sandbox: "read-only", approval: "ask" },
            "workspace-write": { sandbox: "workspace-write", approval: "ask" },
            "danger-full-access": { sandbox: "danger-full-access", approval: "never" },
          },
        },
      },
    ],
  };
}

async function startGateways(): Promise<RunningGateways> {
  const routes: DshGatewayRoute[] = [];
  const env: Record<string, string> = {};
  const closers: Array<() => Promise<void>> = [];
  try {
    const providers = store.settings.providers.filter(isUsableDshProvider);
    for (const [index, provider] of providers.entries()) {
      const gatewayProvider: GatewayProvider = {
        type: provider.type,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
        wireApi: provider.wireApi,
        azure: provider.azureApiVersion
          ? { apiVersion: provider.azureApiVersion }
          : undefined,
      };
      const gateway = await startLlmGateway(gatewayProvider);
      closers.push(gateway.close);
      const apiKeyEnv = apiKeyEnvName(index);
      env[apiKeyEnv] = gateway.token;
      routes.push({
        provider,
        providerName: providerRouteName(provider.id, index),
        apiKeyEnv,
        url: gateway.url,
      });
    }
    if (routes.length === 0) {
      throw new Error("没有可用于 DSH SDK 的 OpenAI 兼容模型提供方");
    }
    return {
      routes,
      env,
      async close() {
        await Promise.allSettled(closers.map((close) => close()));
      },
    };
  } catch (error) {
    await Promise.allSettled(closers.map((close) => close()));
    throw error;
  }
}

/**
 * Embedded agent core: one official `dsh --profile sdk` runtime, driven over
 * the package's stdio JSON-RPC client. The Web surface still uses the per-user
 * `dsh web` host because the browser UI speaks that host's RPC protocol; this
 * runtime is the programmatic channel for connectors and automation.
 */
export class DshAgent {
  private harness: DeepSeekHarness | undefined;
  private gateways: RunningGateways | undefined;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly cwd: string = WORKSPACE_ROOT) {}

  run(prompt: string): Promise<DshAgentRun> {
    const task = this.queue.then(() => this.runOnce(prompt));
    this.queue = task.catch(() => undefined);
    return task;
  }

  private async runOnce(prompt: string): Promise<DshAgentRun> {
    await this.ensure();
    const harness = this.harness;
    if (!harness) throw new Error("DSH SDK runtime 未就绪");
    const result = await harness.run(prompt);
    return {
      sessionId: result.sessionId,
      finalResponse: result.finalResponse,
      notificationCount: result.notifications.length,
      eventCount: result.events.length,
    };
  }

  private async ensure(): Promise<void> {
    if (this.closed) throw new Error("DSH SDK runtime 已关闭");
    if (this.harness) return;
    const gateways = await startGateways();
    let harness: DeepSeekHarness | undefined;
    try {
      const sdkHome = path.join(DATA_DIR, "dsh-sdk-home");
      fs.mkdirSync(sdkHome, { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.cwd, { recursive: true });
      const integration = buildSdkPatch(gateways.routes, this.cwd);
      const patchPath = path.join(sdkHome, "cca-sdk-integration.json");
      fs.writeFileSync(
        patchPath,
        `${JSON.stringify(integration.patch, null, 2)}\n`,
        { mode: 0o600 },
      );
      const bin = resolveDshBin();
      harness = new DeepSeekHarness({
        profile: "sdk",
        cwd: this.cwd,
        provider: integration.provider,
        model: integration.model,
        ...(bin ? { dshBin: bin } : {}),
        dshHome: sdkHome,
        patches: [patchPath],
        env: {
          ...process.env,
          ...gateways.env,
          DSH_HOME: sdkHome,
          DSH_TELEMETRY_DISABLED: "1",
        },
      });
      await harness.start();
      this.gateways = gateways;
      this.harness = harness;
    } catch (error) {
      await harness?.close().catch(() => undefined);
      await gateways.close().catch(() => undefined);
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.harness?.close().catch(() => undefined);
    this.harness = undefined;
    await this.gateways?.close().catch(() => undefined);
    this.gateways = undefined;
  }
}

export const dshAgent = new DshAgent();
