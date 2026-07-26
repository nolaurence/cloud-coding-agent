import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { CopilotClient, CopilotSession, SessionEvent } from "@github/copilot-sdk";
import type { AppSettings, Project, ThreadEvent, ThreadMeta } from "@cca/protocol";
import { CopilotManager } from "./copilot.js";
import { store } from "./store.js";

function sessionEvent(type: SessionEvent["type"], data: unknown): SessionEvent {
  return {
    id: randomUUID(),
    parentId: null,
    timestamp: new Date().toISOString(),
    type,
    data,
  } as SessionEvent;
}

class FakeSession {
  readonly listeners = new Set<(event: SessionEvent) => void>();
  readonly sent: unknown[] = [];
  readonly history: SessionEvent[];
  abortCalls = 0;

  constructor(history: SessionEvent[] = []) {
    this.history = history;
  }

  on(handler: (event: SessionEvent) => void) {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  emit(event: SessionEvent) {
    for (const listener of this.listeners) listener(event);
  }

  async getEvents() {
    return this.history;
  }

  async send(options: unknown) {
    this.sent.push(options);
    return `message-${this.sent.length}`;
  }

  async abort() {
    this.abortCalls += 1;
  }

  async disconnect() {}

  async setModel() {}
}

class FakeClient {
  startCalls = 0;
  failFirstStart = false;
  readonly session: FakeSession;
  readonly createdConfigs: unknown[] = [];

  constructor(session = new FakeSession()) {
    this.session = session;
  }

  async start() {
    this.startCalls += 1;
    if (this.failFirstStart && this.startCalls === 1) throw new Error("runtime unavailable");
  }

  async createSession(config?: unknown) {
    this.createdConfigs.push(config);
    return this.session as unknown as CopilotSession;
  }

  async resumeSession() {
    return this.session as unknown as CopilotSession;
  }

  async deleteSession() {}

  async listModels() {
    return [];
  }

  async stop() {
    return [];
  }
}

function setupStore(t: TestContext, threadId: string, createdAt = Date.now()) {
  const previous = {
    projects: store.projects,
    threads: store.threads,
    settings: store.settings,
    upsertThread: store.upsertThread,
  };
  const project: Project = { id: "project-1", name: "Project", path: process.cwd() };
  const thread: ThreadMeta = {
    id: threadId,
    projectId: project.id,
    title: "会话",
    createdAt,
    updatedAt: createdAt,
    archived: false,
  };
  store.projects = [project];
  store.threads = [thread];
  store.settings = {
    providers: [],
    mcpServers: [],
    skillDirectories: [],
    disabledSkills: [],
  } satisfies AppSettings;
  store.upsertThread = (next) => {
    const index = store.threads.findIndex((candidate) => candidate.id === next.id);
    if (index >= 0) store.threads[index] = next;
    else store.threads.push(next);
  };
  t.after(() => {
    store.projects = previous.projects;
    store.threads = previous.threads;
    store.settings = previous.settings;
    store.upsertThread = previous.upsertThread;
  });
}

test("keeps a request running across assistant tool turns until session.idle", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  const session = new FakeSession();
  const client = new FakeClient(session);
  const manager = new CopilotManager(() => client as unknown as CopilotClient);
  const emitted: ThreadEvent[] = [];
  manager.onThreadEvent((_id, event) => emitted.push(event));
  t.after(() => manager.shutdown());

  await manager.sendMessage(threadId, "修改文件");
  assert.equal(manager.isRunning(threadId), true);
  await assert.rejects(manager.sendMessage(threadId, "重复消息"), /仍在运行/);

  session.emit(sessionEvent("assistant.turn_start", { turnId: "0" }));
  session.emit(
    sessionEvent("tool.execution_start", {
      toolCallId: "tool-1",
      toolName: "apply_patch",
      arguments: { path: "src/index.ts" },
      turnId: "0",
    }),
  );
  session.emit(sessionEvent("assistant.turn_end", { turnId: "0" }));

  assert.equal(manager.isRunning(threadId), true);
  assert.equal(emitted.filter((event) => event.kind === "turn.end").length, 0);

  session.emit(
    sessionEvent("tool.execution_complete", {
      toolCallId: "tool-1",
      success: true,
      result: { content: "ok", detailedContent: "updated src/index.ts" },
      turnId: "0",
    }),
  );
  session.emit(sessionEvent("session.idle", {}));

  assert.equal(manager.isRunning(threadId), false);
  assert.equal(emitted.filter((event) => event.kind === "turn.end").length, 1);
  const toolComplete = emitted.find((event) => event.kind === "tool.complete");
  assert.equal(toolComplete?.kind === "tool.complete" ? toolComplete.activity.result : undefined, "updated src/index.ts");
});

test("clears failed startup state so a message can be retried", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  const session = new FakeSession();
  const client = new FakeClient(session);
  client.failFirstStart = true;
  const manager = new CopilotManager(() => client as unknown as CopilotClient);
  t.after(() => manager.shutdown());

  await assert.rejects(manager.sendMessage(threadId, "first"), /runtime unavailable/);
  assert.equal(manager.isRunning(threadId), false);

  await manager.sendMessage(threadId, "second");
  assert.equal(client.startCalls, 2);
  assert.equal(session.sent.length, 1);
  assert.equal(manager.isRunning(threadId), true);
  await manager.interrupt(threadId);
  assert.equal(session.abortCalls, 1);
  assert.equal(manager.isRunning(threadId), false);
});

test("overrides the OpenAI provider User-Agent rejected by compatible gateways", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  store.threads[0]!.model = { providerId: "provider-1", modelId: "gpt-5.4" };
  store.settings.providers = [
    {
      id: "provider-1",
      name: "OpenAI compatible",
      type: "openai",
      baseUrl: "https://example.com/v1",
      apiKey: " secret ",
      wireApi: "responses",
      models: [{ id: "gpt-5.4" }],
    },
  ];
  const client = new FakeClient();
  const manager = new CopilotManager(() => client as unknown as CopilotClient);
  t.after(() => manager.shutdown());

  await manager.sendMessage(threadId, "test");
  const config = client.createdConfigs[0] as {
    provider?: { apiKey?: string; headers?: Record<string, string> };
  };
  assert.equal(config.provider?.apiKey, "secret");
  assert.equal(config.provider?.headers?.["User-Agent"], "cloud-coding-agent/0.1");
  await manager.interrupt(threadId);
});

test("restores tool failures and interrupted tools from session history", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId, Date.now() - 10_000);
  const history = [
    sessionEvent("user.message", { content: "修改文件" }),
    sessionEvent("assistant.turn_start", { turnId: "0" }),
    sessionEvent("tool.execution_start", {
      toolCallId: "tool-running",
      toolName: "edit",
      arguments: { path: "a.ts" },
    }),
    sessionEvent("tool.execution_complete", {
      toolCallId: "tool-failed",
      success: false,
      error: { message: "permission denied" },
      toolDescription: { name: "write" },
    }),
  ];
  const session = new FakeSession(history);
  const client = new FakeClient(session);
  const manager = new CopilotManager(() => client as unknown as CopilotClient);
  t.after(() => manager.shutdown());

  const snapshot = await manager.subscribe(threadId);
  assert.equal(snapshot.kind, "snapshot");
  if (snapshot.kind !== "snapshot") return;

  assert.deepEqual(
    snapshot.activities.map((activity) => ({ id: activity.id, status: activity.status, result: activity.result })),
    [
      { id: "tool-running", status: "error", result: "工具执行被中断" },
      { id: "tool-failed", status: "error", result: "permission denied" },
    ],
  );
});
