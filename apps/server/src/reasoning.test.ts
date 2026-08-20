import assert from "node:assert/strict";
import test from "node:test";
import {
  flattenModels,
  normalizeConfiguredModelRef,
  normalizeContextWindowTokens,
  normalizeModelRefReasoning,
  resolveModelContextWindowTokens,
  resolveThreadModel,
  resolveThreadModelProviderId,
} from "@cca/protocol";
import type { AppSettings, ModelOption } from "@cca/protocol";
import { CopilotManager } from "./copilot.js";
import { store } from "./store.js";

test("flattenModels exposes configured reasoning capabilities", () => {
  const models = flattenModels({
    providers: [
      {
        id: "provider",
        name: "Provider",
        type: "openai",
        baseUrl: "https://example.com/v1",
        models: [
          { id: "supported", supportedReasoningEfforts: ["low", "medium", "high"] },
          { id: "legacy", reasoningEffort: true },
          { id: "unsupported", reasoningEffort: false },
          { id: "unknown" },
        ],
      },
    ],
    connectors: [],
    mcpServers: [],
    skillDirectories: [],
    disabledSkills: [],
  });

  assert.deepEqual(models[0]?.supportedReasoningEfforts, ["low", "medium", "high"]);
  assert.deepEqual(models[1]?.supportedReasoningEfforts, ["low", "medium", "high", "xhigh"]);
  assert.deepEqual(models[2]?.supportedReasoningEfforts, []);
  assert.equal(models[3]?.supportedReasoningEfforts, undefined);
});

test("flattenModels resolves reasoning efforts from the matching model catalog", () => {
  const catalog: ModelOption[] = [
    {
      ref: { providerId: "copilot", modelId: "gpt-5.6-sol" },
      label: "GPT-5.6 Sol",
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      defaultReasoningEffort: "medium",
    },
    {
      ref: { providerId: "copilot", modelId: "gpt-5.4" },
      label: "GPT-5.4",
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"],
    },
  ];
  const models = flattenModels(
    {
      providers: [
        {
          id: "custom",
          name: "Custom",
          type: "openai",
          baseUrl: "https://example.com/v1",
          models: [
            { id: "gpt-5.6-sol" },
            { id: "gpt-5.4" },
            { id: "unknown" },
            { id: "gpt-5.6-sol-disabled", reasoningEffort: false },
          ],
        },
      ],
      connectors: [],
    mcpServers: [],
      skillDirectories: [],
      disabledSkills: [],
    },
    catalog,
  );

  assert.deepEqual(models[0]?.supportedReasoningEfforts, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(models[0]?.defaultReasoningEffort, "medium");
  assert.deepEqual(models[1]?.supportedReasoningEfforts, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.equal(models[2]?.supportedReasoningEfforts, undefined);
  assert.deepEqual(models[3]?.supportedReasoningEfforts, []);
});

test("flattenModels uses model-specific fallbacks for existing ID-only provider configs", () => {
  const models = flattenModels({
    providers: [
      {
        id: "custom",
        name: "Custom",
        type: "openai",
        baseUrl: "https://example.com/v1",
        models: [{ id: "gpt-5.6-terra" }, { id: "gpt-5.4" }, { id: "gpt-4o" }],
      },
    ],
    connectors: [],
    mcpServers: [],
    skillDirectories: [],
    disabledSkills: [],
  });

  assert.deepEqual(models[0]?.supportedReasoningEfforts, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(models[1]?.supportedReasoningEfforts, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
  ]);
  assert.equal(models[2]?.supportedReasoningEfforts, undefined);
});

test("resolves configured context windows before known model defaults", () => {
  const settings: AppSettings = {
    providers: [
      {
        id: "custom",
        name: "Custom",
        type: "openai",
        baseUrl: "https://example.com/v1",
        models: [
          { id: "gpt-5.6-sol", contextWindowTokens: 300_000 },
          { id: "unknown" },
        ],
      },
    ],
    connectors: [],
    mcpServers: [],
    skillDirectories: [],
    disabledSkills: [],
  };

  assert.equal(
    resolveModelContextWindowTokens(settings, {
      providerId: "custom",
      modelId: "gpt-5.6-sol",
    }),
    300_000,
  );
  assert.equal(
    resolveModelContextWindowTokens(
      { ...settings, providers: [] },
      { providerId: "copilot", modelId: "GPT-5.6-SOL" },
    ),
    258_000,
  );
  assert.equal(
    resolveModelContextWindowTokens(settings, {
      providerId: "custom",
      modelId: "unknown",
    }),
    undefined,
  );
  assert.equal(normalizeContextWindowTokens(258_000), 258_000);
  assert.equal(normalizeContextWindowTokens("258000"), undefined);
  assert.equal(normalizeContextWindowTokens(258_000.5), undefined);
  assert.equal(normalizeContextWindowTokens(0), undefined);
});

test("persisted efforts are only removed when exact capabilities exclude them", () => {
  const settings: AppSettings = {
    providers: [
      {
        id: "custom",
        name: "Custom",
        type: "openai" as const,
        baseUrl: "https://example.com/v1",
        models: [
          { id: "unknown" },
          { id: "legacy", reasoningEffort: true },
          { id: "gpt-5.6-sol" },
          { id: "explicit", supportedReasoningEfforts: ["low"] },
        ],
      },
    ],
    connectors: [],
    mcpServers: [],
    skillDirectories: [],
    disabledSkills: [],
  };

  assert.deepEqual(
    normalizeConfiguredModelRef(settings, {
      providerId: "custom",
      modelId: "unknown",
      reasoningEffort: "high",
    }),
    { providerId: "custom", modelId: "unknown", reasoningEffort: "high" },
  );
  assert.equal(
    normalizeConfiguredModelRef(settings, {
      providerId: "custom",
      modelId: "legacy",
      reasoningEffort: "high",
    }).reasoningEffort,
    "high",
  );
  assert.equal(
    normalizeConfiguredModelRef(settings, {
      providerId: "custom",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "max",
    }).reasoningEffort,
    "max",
  );
  const copilotOptions: ModelOption[] = [
    {
      ref: { providerId: "copilot", modelId: "gpt-5.6-sol" },
      label: "GPT-5.6 Sol",
      supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    },
    {
      ref: { providerId: "copilot", modelId: "gpt-4o" },
      label: "GPT-4o",
      supportedReasoningEfforts: [],
    },
  ];
  assert.equal(
    normalizeModelRefReasoning(
      { providerId: "copilot", modelId: "gpt-5.6-sol", reasoningEffort: "max" },
      copilotOptions,
    ).reasoningEffort,
    "max",
  );
  assert.deepEqual(
    normalizeModelRefReasoning(
      { providerId: "copilot", modelId: "gpt-4o", reasoningEffort: "high" },
      copilotOptions,
    ),
    { providerId: "copilot", modelId: "gpt-4o" },
  );
  assert.deepEqual(
    normalizeConfiguredModelRef(settings, {
      providerId: "custom",
      modelId: "explicit",
      reasoningEffort: "high",
    }),
    { providerId: "custom", modelId: "explicit" },
  );
});

test("thread model resolution keeps the provider selected when the thread was created", () => {
  const thread = {
    modelProviderId: "copilot",
    model: undefined,
  };
  const changedDefault = { providerId: "custom", modelId: "custom-model" };

  assert.equal(resolveThreadModelProviderId(thread, changedDefault), "copilot");
  assert.equal(resolveThreadModel(thread, changedDefault), undefined);
  assert.equal(
    resolveThreadModel(
      { ...thread, model: { providerId: "custom", modelId: "stale-model" } },
      changedDefault,
    ),
    undefined,
  );
});

function seedRuntime(
  manager: CopilotManager,
  session: {
    setModel: (
      model: string,
      options?: { reasoningEffort?: string; modelCapabilities?: unknown },
    ) => Promise<void>;
    disconnect: () => Promise<void>;
  },
  running = false,
) {
  const runtime = {
    threadId: "thread",
    session,
    attaching: null,
    messages: [],
    activities: [],
    running,
    currentTurnId: null,
    detachTimer: null,
    subscribers: 1,
  };
  const threads = (manager as unknown as { threads: Map<string, unknown> }).threads;
  threads.set(runtime.threadId, runtime);
  return runtime;
}

test("setThreadModel hot-switches within a provider without disconnecting", async () => {
  const calls: unknown[] = [];
  let disconnects = 0;
  const manager = new CopilotManager();
  seedRuntime(manager, {
    setModel: async (...args) => {
      calls.push(args);
    },
    disconnect: async () => {
      disconnects += 1;
    },
  });

  await manager.setThreadModel(
    "thread",
    { providerId: "provider", modelId: "old" },
    { providerId: "provider", modelId: "new", reasoningEffort: "max" },
  );

  assert.deepEqual(calls, [["new", { reasoningEffort: "max" }]]);
  assert.equal(disconnects, 0);
});

test("setThreadModel applies configured context limits during a hot switch", async () => {
  const previousSettings = store.settings;
  store.settings = {
    providers: [
      {
        id: "provider",
        name: "Provider",
        type: "openai",
        baseUrl: "https://example.com/v1",
        models: [{ id: "new", contextWindowTokens: 300_000 }],
      },
    ],
    connectors: [],
    mcpServers: [],
    skillDirectories: [],
    disabledSkills: [],
  };
  try {
    const calls: unknown[] = [];
    const manager = new CopilotManager();
    seedRuntime(manager, {
      setModel: async (...args) => {
        calls.push(args);
      },
      disconnect: async () => {},
    });

    await manager.setThreadModel(
      "thread",
      { providerId: "provider", modelId: "old" },
      { providerId: "provider", modelId: "new" },
    );

    assert.deepEqual(calls, [
      [
        "new",
        {
          modelCapabilities: {
            limits: {
              max_context_window_tokens: 300_000,
              max_prompt_tokens: 284_000,
            },
          },
        },
      ],
    ]);
  } finally {
    store.settings = previousSettings;
  }
});

test("setThreadModel rejects cross-provider switch on an attached session", async () => {
  let disconnects = 0;
  const manager = new CopilotManager();
  seedRuntime(manager, {
    setModel: async () => {
      throw new Error("setModel should not run");
    },
    disconnect: async () => {
      disconnects += 1;
    },
  });

  await assert.rejects(
    manager.setThreadModel(
      "thread",
      { providerId: "first", modelId: "model" },
      { providerId: "second", modelId: "model" },
    ),
    /不支持切换模型提供方/,
  );
  assert.equal(disconnects, 0);
});

test("setThreadModel rejects cross-provider switch on a fresh thread without session", async () => {
  const manager = new CopilotManager();
  const threads = (manager as unknown as { threads: Map<string, unknown> }).threads;
  threads.set("thread", {
    threadId: "thread",
    session: null,
    attaching: null,
    messages: [],
    activities: [],
    running: false,
    currentTurnId: null,
    detachTimer: null,
    subscribers: 1,
  });

  await assert.rejects(
    manager.setThreadModel(
      "thread",
      { providerId: "first", modelId: "model" },
      { providerId: "second", modelId: "model" },
    ),
    /不支持切换模型提供方/,
  );
});

test("setThreadModel rejects cross-provider switch without a runtime", async () => {
  const manager = new CopilotManager();

  await assert.rejects(
    manager.setThreadModel(
      "missing-thread",
      { providerId: "first", modelId: "model" },
      { providerId: "second", modelId: "model" },
    ),
    /不支持切换模型提供方/,
  );
});

test("setThreadModel rejects changes while a turn is running", async () => {
  const manager = new CopilotManager();
  seedRuntime(
    manager,
    {
      setModel: async () => {},
      disconnect: async () => {},
    },
    true,
  );

  await assert.rejects(
    manager.setThreadModel(
      "thread",
      { providerId: "provider", modelId: "old" },
      { providerId: "provider", modelId: "new" },
    ),
    /当前任务运行中/,
  );
});
