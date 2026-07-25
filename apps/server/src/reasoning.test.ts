import assert from "node:assert/strict";
import test from "node:test";
import { REASONING_EFFORTS, flattenModels } from "@cca/protocol";
import { CopilotManager } from "./copilot.js";

test("flattenModels exposes configured reasoning capabilities", () => {
  const models = flattenModels({
    providers: [
      {
        id: "provider",
        name: "Provider",
        type: "openai",
        baseUrl: "https://example.com/v1",
        models: [
          { id: "supported", reasoningEffort: true },
          { id: "unsupported", reasoningEffort: false },
          { id: "unknown" },
        ],
      },
    ],
    mcpServers: [],
    skillDirectories: [],
    disabledSkills: [],
  });

  assert.deepEqual(models[0]?.supportedReasoningEfforts, [...REASONING_EFFORTS]);
  assert.deepEqual(models[1]?.supportedReasoningEfforts, []);
  assert.equal(models[2]?.supportedReasoningEfforts, undefined);
});

function seedRuntime(
  manager: CopilotManager,
  session: {
    setModel: (model: string, options?: { reasoningEffort?: string }) => Promise<void>;
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
    { providerId: "provider", modelId: "new", reasoningEffort: "high" },
  );

  assert.deepEqual(calls, [["new", { reasoningEffort: "high" }]]);
  assert.equal(disconnects, 0);
});

test("setThreadModel disconnects across providers without deleting the runtime", async () => {
  let disconnects = 0;
  const manager = new CopilotManager();
  const runtime = seedRuntime(manager, {
    setModel: async () => {
      throw new Error("setModel should not run");
    },
    disconnect: async () => {
      disconnects += 1;
    },
  });

  await manager.setThreadModel(
    "thread",
    { providerId: "first", modelId: "model" },
    { providerId: "second", modelId: "model" },
  );

  assert.equal(disconnects, 1);
  assert.equal(runtime.session, null);
  assert.equal(
    (manager as unknown as { threads: Map<string, unknown> }).threads.has("thread"),
    true,
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
