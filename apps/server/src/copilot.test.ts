import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { CopilotClient, CopilotSession, SessionEvent } from "@github/copilot-sdk";
import type { AppSettings, Project, ThreadEvent, ThreadMeta } from "@cca/protocol";
import { CopilotManager, normalizeGeneratedCommitMessage } from "./copilot.js";
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
  disconnectCalls = 0;

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

  async sendAndWait(options: unknown) {
    this.sent.push(options);
    return sessionEvent("assistant.message", {
      messageId: `message-${this.sent.length}`,
      content: "```text\nfeat(git): generate commit messages\n```",
    }) as Extract<SessionEvent, { type: "assistant.message" }>;
  }

  async abort() {
    this.abortCalls += 1;
  }

  async disconnect() {
    this.disconnectCalls += 1;
  }

  async setModel() {}
}

class FakeClient {
  startCalls = 0;
  failFirstStart = false;
  readonly session: FakeSession;
  readonly createdConfigs: unknown[] = [];
  readonly deletedSessionIds: string[] = [];

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

  async deleteSession(sessionId: string) {
    this.deletedSessionIds.push(sessionId);
  }

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
  const project: Project = { id: "project-1", name: "Project", path: process.cwd(), ownerId: "admin" };
  const thread: ThreadMeta = {
    id: threadId,
    projectId: project.id,
    title: "会话",
    createdAt,
    updatedAt: createdAt,
    archived: false,
    userId: project.ownerId,
  };
  store.projects = [project];
  store.threads = [thread];
  store.settings = {
    providers: [],
    connectors: [],
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

test("generates a commit message in an isolated tool-free session", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  const session = new FakeSession();
  const client = new FakeClient(session);
  const manager = new CopilotManager(() => client as unknown as CopilotClient);
  t.after(() => manager.shutdown());

  const message = await manager.generateCommitMessage(threadId, "admin", "diff --git a/a b/a\n+change", false);
  assert.equal(message, "feat(git): generate commit messages");
  assert.equal(client.createdConfigs.length, 1);
  const config = client.createdConfigs[0] as { sessionId: string; tools: unknown[]; availableTools: unknown[] };
  assert.match(config.sessionId, /^commit-message-/);
  assert.deepEqual(config.tools, []);
  assert.deepEqual(config.availableTools, []);
  assert.match(JSON.stringify(session.sent[0]), /<staged_diff>/);
  assert.equal(session.disconnectCalls, 1);
  assert.deepEqual(client.deletedSessionIds, [config.sessionId]);
});

test("normalizes generated commit message wrappers and rejects empty output", () => {
  assert.equal(normalizeGeneratedCommitMessage('Commit message: "fix: handle empty input"'), "fix: handle empty input");
  assert.throws(() => normalizeGeneratedCommitMessage("  "), /未生成有效/);
});

test("attaches uploaded images to the emitted and restored user message", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  const session = new FakeSession();
  const client = new FakeClient(session);
  const manager = new CopilotManager(() => client as unknown as CopilotClient);
  const emitted: ThreadEvent[] = [];
  manager.onThreadEvent((_id, event) => emitted.push(event));
  t.after(() => manager.shutdown());

  await manager.sendMessage(threadId, "看一下截图", [
    { path: "/tmp/image.png", displayName: "screenshot.png", imageId: "image.png" },
  ]);
  session.emit(sessionEvent("user.message", { content: "看一下截图" }));

  const userEvent = emitted.find((event) => event.kind === "user.message");
  assert.deepEqual(userEvent?.kind === "user.message" ? userEvent.message.attachments : undefined, [
    { id: "image.png", displayName: "screenshot.png", kind: "image", ownerId: "" },
  ]);
  assert.deepEqual(store.getThread(threadId)?.messageAttachments, {
    [userEvent?.kind === "user.message" ? userEvent.message.id : ""]: [
      { id: "image.png", displayName: "screenshot.png", kind: "image", ownerId: "" },
    ],
  });
});

test("keeps attachments when the first image message updates the title", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  store.threads[0]!.title = "新会话";
  const session = new FakeSession();
  const manager = new CopilotManager(() => new FakeClient(session) as unknown as CopilotClient);
  t.after(() => manager.shutdown());

  await manager.sendMessage(threadId, "看一下截图", [
    { path: "/tmp/image.png", displayName: "screenshot.png", imageId: "image.png" },
  ]);
  const event = sessionEvent("user.message", { content: "看一下截图" });
  session.emit(event);

  assert.equal(store.getThread(threadId)?.title, "看一下截图");
  assert.deepEqual(store.getThread(threadId)?.messageAttachments?.[event.id], [
    { id: "image.png", displayName: "screenshot.png", kind: "image", ownerId: "" },
  ]);
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

test("keeps streamed assistant text in snapshots and after an interrupt", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  const session = new FakeSession();
  const client = new FakeClient(session);
  const manager = new CopilotManager(() => client as unknown as CopilotClient);
  t.after(() => manager.shutdown());

  await manager.sendMessage(threadId, "解释当前实现");
  session.emit(
    sessionEvent("assistant.message_delta", {
      messageId: "assistant-partial",
      deltaContent: "这是尚未完成的回答",
    }),
  );

  const runningSnapshot = await manager.subscribe(threadId);
  assert.equal(runningSnapshot.kind, "snapshot");
  if (runningSnapshot.kind !== "snapshot") return;
  assert.equal(runningSnapshot.live?.text, "这是尚未完成的回答");

  await manager.interrupt(threadId);
  const interruptedSnapshot = await manager.subscribe(threadId);
  assert.equal(interruptedSnapshot.kind, "snapshot");
  if (interruptedSnapshot.kind !== "snapshot") return;
  assert.equal(interruptedSnapshot.live, undefined);
  assert.equal(
    interruptedSnapshot.messages.find((message) => message.id === "assistant-partial")?.text,
    "这是尚未完成的回答",
  );
});

test("configures Responses gateways without the free-form apply_patch tool", async (t) => {
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
    excludedTools?: string[];
    systemMessage?: { content?: string };
  };
  assert.equal(config.provider?.apiKey, "secret");
  assert.equal(config.provider?.headers?.["User-Agent"], "cloud-coding-agent/0.1");
  assert.deepEqual(config.excludedTools, ["builtin:apply_patch"]);
  assert.match(config.systemMessage?.content ?? "", /apply_patch tool is unavailable/);
  await manager.interrupt(threadId);
});

test("keeps apply_patch available for Chat Completions providers", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  store.threads[0]!.model = { providerId: "provider-1", modelId: "k3" };
  store.settings.providers = [
    {
      id: "provider-1",
      name: "OpenAI compatible",
      type: "openai",
      baseUrl: "https://example.com/v1",
      wireApi: "completions",
      models: [{ id: "k3" }],
    },
  ];
  const client = new FakeClient();
  const manager = new CopilotManager(() => client as unknown as CopilotClient);
  t.after(() => manager.shutdown());

  await manager.sendMessage(threadId, "test");
  const config = client.createdConfigs[0] as {
    excludedTools?: string[];
    systemMessage?: { content?: string };
  };
  assert.equal(config.excludedTools, undefined);
  assert.doesNotMatch(config.systemMessage?.content ?? "", /apply_patch tool is unavailable/);
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

test("restores an unfinished streamed answer from session history", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId, Date.now() - 10_000);
  const history = [
    sessionEvent("user.message", { content: "解释实现" }),
    sessionEvent("assistant.message_delta", {
      messageId: "assistant-from-history",
      deltaContent: "保留下来的半截回答",
    }),
    sessionEvent("abort", {}),
  ];
  const session = new FakeSession(history);
  const client = new FakeClient(session);
  const manager = new CopilotManager(() => client as unknown as CopilotClient);
  t.after(() => manager.shutdown());

  const snapshot = await manager.subscribe(threadId);
  assert.equal(snapshot.kind, "snapshot");
  if (snapshot.kind !== "snapshot") return;
  assert.equal(
    snapshot.messages.find((message) => message.id === "assistant-from-history")?.text,
    "保留下来的半截回答",
  );
});

test("records the current collaborator as the message and attachment author", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  store.threads[0]!.userId = "thread-owner";
  store.projects[0]!.ownerId = "thread-owner";
  const session = new FakeSession();
  const manager = new CopilotManager(() => new FakeClient(session) as unknown as CopilotClient);
  const emitted: ThreadEvent[] = [];
  manager.onThreadEvent((_id, event) => emitted.push(event));
  t.after(() => manager.shutdown());

  await manager.sendMessage(
    threadId,
    "协作者消息",
    [{ path: "/tmp/image.png", displayName: "image.png", imageId: "image.png" }],
    "collaborator",
  );
  const event = sessionEvent("user.message", { content: "协作者消息" });
  session.emit(event);

  const messageEvent = emitted.find((candidate) => candidate.kind === "user.message");
  assert.equal(
    messageEvent?.kind === "user.message" ? messageEvent.message.authorId : undefined,
    "collaborator",
  );
  assert.equal(store.getThread(threadId)?.messageAuthors?.[event.id], "collaborator");
  assert.equal(store.getThread(threadId)?.messageAttachments?.[event.id]?.[0]?.ownerId, "collaborator");
});

test("a new subscriber does not replace the actor session during a running turn", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  store.threads[0]!.userId = "thread-owner";
  store.projects[0]!.ownerId = "thread-owner";
  const client = new FakeClient();
  const manager = new CopilotManager(() => client as unknown as CopilotClient);
  t.after(() => manager.shutdown());

  await manager.sendMessage(threadId, "协作者正在处理", undefined, "collaborator");
  assert.equal(client.createdConfigs.length, 1);

  await manager.subscribe(threadId, "readonly-viewer");
  assert.equal(client.createdConfigs.length, 1);
  assert.equal(manager.isRunning(threadId), true);
});

test("creates an isolated session with only the authenticated Git extension", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  const client = new FakeClient();
  const manager = new CopilotManager(() => client as unknown as CopilotClient);
  t.after(() => manager.shutdown());

  await manager.sendMessage(threadId, "拉取远程更新");
  const config = client.createdConfigs[0] as {
    workingDirectory?: string;
    enableConfigDiscovery?: boolean;
    requestExtensions?: boolean;
    mcpServers?: Record<string, unknown>;
    customAgents?: unknown[];
    skillDirectories?: string[];
    pluginDirectories?: string[];
    enableSkills?: boolean;
    enableFileHooks?: boolean;
    memory?: { enabled?: boolean };
    enableSessionStore?: boolean;
    skipEmbeddingRetrieval?: boolean;
    embeddingCacheStorage?: string;
    sandbox?: Record<string, boolean>;
    tools?: Array<{ name: string; handler?: (args: unknown) => Promise<unknown> }>;
    systemMessage?: { content?: string };
  };
  assert.equal(config.workingDirectory, process.cwd());
  assert.equal(config.enableConfigDiscovery, false);
  assert.equal(config.requestExtensions, false);
  assert.deepEqual(config.mcpServers, {});
  assert.deepEqual(config.customAgents, []);
  assert.deepEqual(config.skillDirectories, []);
  assert.deepEqual(config.pluginDirectories, []);
  assert.equal(config.enableSkills, false);
  assert.equal(config.enableFileHooks, false);
  assert.deepEqual(config.memory, { enabled: false });
  assert.equal(config.enableSessionStore, false);
  assert.equal(config.skipEmbeddingRetrieval, true);
  assert.equal(config.embeddingCacheStorage, "in-memory");
  assert.deepEqual(config.sandbox, {
    enabled: true,
    allowBypass: false,
    addCurrentWorkingDirectory: true,
    sandboxMcpServers: true,
    sandboxLspServers: true,
  });
  assert.deepEqual(config.tools?.map((tool) => tool.name), ["authenticated_git", "browser_use"]);
  assert.ok(config.tools?.[0]?.handler);
  assert.ok(config.tools?.[1]?.handler);
  assert.match(config.systemMessage?.content ?? "", /authenticated_git/);
  await manager.interrupt(threadId);
});

test("rejects a thread whose owner does not own its workspace", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  store.threads[0]!.userId = "other-user";
  const manager = new CopilotManager(() => new FakeClient() as unknown as CopilotClient);
  t.after(() => manager.shutdown());

  await assert.rejects(manager.sendMessage(threadId, "test"), /会话与工作区所有者不匹配/);
  assert.equal(manager.isRunning(threadId), false);
});
