import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { CopilotClient, CopilotSession, SessionEvent } from "@github/copilot-sdk";
import type { AppSettings, Project, ThreadEvent, ThreadMeta } from "@cca/protocol";
import { CopilotManager, normalizeGeneratedCommitMessage } from "./copilot.js";
import { store } from "./store.js";

function sessionEvent(
  type: SessionEvent["type"],
  data: unknown,
  agentId?: string,
): SessionEvent {
  return {
    id: randomUUID(),
    parentId: null,
    timestamp: new Date().toISOString(),
    type,
    data,
    ...(agentId ? { agentId } : {}),
  } as SessionEvent;
}

class FakeSession {
  readonly listeners = new Set<(event: SessionEvent) => void>();
  readonly sent: unknown[] = [];
  readonly history: SessionEvent[];
  abortCalls = 0;
  compactCalls = 0;
  disconnectCalls = 0;
  compactResult = {
    success: true,
    tokensRemoved: 18_000,
    messagesRemoved: 8,
    summaryContent: "summary",
    contextWindow: {
      tokenLimit: 128_000,
      currentTokens: 12_000,
      messagesLength: 5,
    },
  };
  readonly rpc = {
    history: {
      compact: async () => {
        this.compactCalls += 1;
        return this.compactResult;
      },
    },
  };

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

test("streams SDK subagent work without flattening child tools into the parent", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  const session = new FakeSession();
  const client = new FakeClient(session);
  const manager = new CopilotManager(() => client as unknown as CopilotClient);
  const emitted: ThreadEvent[] = [];
  manager.onThreadEvent((_id, event) => emitted.push(event));
  t.after(() => manager.shutdown());

  await manager.sendMessage(threadId, "并行探索代码库");
  session.emit(
    sessionEvent("tool.execution_start", {
      toolCallId: "task-call",
      toolName: "task",
      arguments: {
        description: "查找会话恢复逻辑",
        prompt: "定位并解释会话恢复相关代码",
        agent_type: "explore",
      },
    }),
  );
  session.emit(
    sessionEvent(
      "subagent.started",
      {
        toolCallId: "task-call",
        agentName: "explore",
        agentDisplayName: "Explore",
        agentDescription: "代码库探索代理",
        model: "gpt-5-mini",
      },
      "agent-1",
    ),
  );
  session.emit(
    sessionEvent(
      "tool.execution_start",
      {
        toolCallId: "child-read",
        toolName: "read_file",
        arguments: { path: "src/session.ts" },
      },
      "agent-1",
    ),
  );
  session.emit(
    sessionEvent(
      "assistant.message_delta",
      { messageId: "child-message", deltaContent: "正在检查" },
      "agent-1",
    ),
  );
  session.emit(
    sessionEvent(
      "tool.execution_complete",
      {
        toolCallId: "child-read",
        success: true,
        result: { content: "session source" },
      },
      "agent-1",
    ),
  );
  session.emit(
    sessionEvent(
      "assistant.message",
      {
        messageId: "child-message",
        content: "恢复逻辑位于 src/session.ts",
      },
      "agent-1",
    ),
  );
  session.emit(
    sessionEvent(
      "subagent.completed",
      {
        toolCallId: "task-call",
        agentName: "explore",
        agentDisplayName: "Explore",
        model: "gpt-5-mini",
        durationMs: 1_250,
        totalTokens: 420,
        totalToolCalls: 1,
      },
      "agent-1",
    ),
  );
  session.emit(
    sessionEvent("tool.execution_complete", {
      toolCallId: "task-call",
      success: true,
      result: { content: "恢复逻辑位于 src/session.ts" },
    }),
  );
  session.emit(sessionEvent("session.idle", {}));

  const snapshot = await manager.subscribe(threadId);
  assert.equal(snapshot.kind, "snapshot");
  if (snapshot.kind !== "snapshot") return;
  assert.deepEqual(snapshot.activities.map((activity) => activity.id), ["task-call"]);
  assert.equal(snapshot.subagents?.length, 1);
  const subagent = snapshot.subagents?.[0];
  assert.equal(subagent?.id, "agent-1");
  assert.equal(subagent?.agentDescription, "代码库探索代理");
  assert.equal(subagent?.taskDescription, "查找会话恢复逻辑");
  assert.equal(subagent?.prompt, "定位并解释会话恢复相关代码");
  assert.equal(subagent?.status, "complete");
  assert.equal(subagent?.messages[0]?.role, "assistant");
  assert.equal(subagent?.messages[0]?.text, "恢复逻辑位于 src/session.ts");
  assert.deepEqual(subagent?.activities.map((activity) => activity.id), ["child-read"]);
  assert.ok(emitted.some((event) => event.kind === "subagent.message_delta"));
});

test("keeps background multi-turn agents idle and preserves every follow-up prompt", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  const session = new FakeSession();
  const manager = new CopilotManager(
    () => new FakeClient(session) as unknown as CopilotClient,
  );
  t.after(() => manager.shutdown());

  await manager.sendMessage(threadId, "后台检查代码");
  session.emit(sessionEvent("tool.execution_start", {
    toolCallId: "background-task",
    toolName: "task",
    arguments: {
      description: "持续检查代码",
      prompt: "先检查服务端",
      agent_type: "explore",
      mode: "background",
    },
  }));
  session.emit(sessionEvent("subagent.started", {
    toolCallId: "background-task",
    agentName: "explore",
    agentDisplayName: "Explore",
    agentDescription: "代码库探索代理",
  }, "background-agent"));
  session.emit(sessionEvent("tool.execution_complete", {
    toolCallId: "background-task",
    success: true,
    result: { content: "后台代理已启动，agent_id=background-agent" },
  }));
  session.emit(sessionEvent("user.message", { content: "先检查服务端" }, "background-agent"));
  session.emit(sessionEvent("assistant.message", {
    messageId: "background-answer-1",
    content: "服务端检查完成",
  }, "background-agent"));
  session.emit(sessionEvent("system.notification", {
    content: "后台代理正在等待后续任务",
    kind: {
      type: "agent_idle",
      agentId: "background-agent",
      agentType: "explore",
      description: "持续检查代码",
    },
  }));
  session.emit(sessionEvent("session.idle", {}));

  let snapshot = await manager.subscribe(threadId);
  assert.equal(snapshot.kind, "snapshot");
  if (snapshot.kind !== "snapshot") return;
  let subagent = snapshot.subagents?.[0];
  assert.equal(subagent?.status, "idle");
  assert.deepEqual(
    subagent?.messages.map((message) => [message.role, message.text]),
    [
      ["user", "先检查服务端"],
      ["assistant", "服务端检查完成"],
    ],
  );
  assert.ok(!subagent?.messages.some((message) => message.text.includes("agent_id")));

  await manager.sendMessage(threadId, "让后台代理继续检查");
  session.emit(sessionEvent("user.message", { content: "继续检查 Web 状态" }, "background-agent"));
  session.emit(sessionEvent("assistant.message", {
    messageId: "background-answer-2",
    content: "Web 状态检查完成",
  }, "background-agent"));
  session.emit(sessionEvent("system.notification", {
    content: "后台代理再次等待",
    kind: {
      type: "agent_idle",
      agentId: "background-agent",
      agentType: "explore",
      description: "持续检查代码",
    },
  }));
  session.emit(sessionEvent("session.idle", {}));

  snapshot = await manager.subscribe(threadId);
  assert.equal(snapshot.kind, "snapshot");
  if (snapshot.kind !== "snapshot") return;
  subagent = snapshot.subagents?.[0];
  assert.equal(subagent?.status, "idle");
  assert.deepEqual(
    subagent?.messages.map((message) => [message.role, message.text]),
    [
      ["user", "先检查服务端"],
      ["assistant", "服务端检查完成"],
      ["user", "继续检查 Web 状态"],
      ["assistant", "Web 状态检查完成"],
    ],
  );
});

test("tracks context usage in events, snapshots, and thread metadata", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  const session = new FakeSession();
  const client = new FakeClient(session);
  const manager = new CopilotManager(() => client as unknown as CopilotClient);
  const emitted: ThreadEvent[] = [];
  manager.onThreadEvent((_id, event) => emitted.push(event));
  t.after(() => manager.shutdown());

  await manager.subscribe(threadId);
  session.emit(
    sessionEvent("session.usage_info", {
      currentTokens: 24_576,
      tokenLimit: 128_000,
      messagesLength: 12,
    }),
  );

  const usage = { usedTokens: 24_576, maxTokens: 128_000 };
  assert.deepEqual(
    emitted.find((event) => event.kind === "context.usage"),
    { kind: "context.usage", usage },
  );
  assert.deepEqual(store.getThread(threadId)?.contextUsage, usage);
  const snapshot = await manager.subscribe(threadId);
  assert.equal(snapshot.kind, "snapshot");
  if (snapshot.kind !== "snapshot") return;
  assert.deepEqual(snapshot.contextUsage, usage);
});

test("manually compacts context and updates usage", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  const session = new FakeSession();
  const client = new FakeClient(session);
  const manager = new CopilotManager(() => client as unknown as CopilotClient);
  const emitted: ThreadEvent[] = [];
  manager.onThreadEvent((_id, event) => emitted.push(event));
  t.after(() => manager.shutdown());

  const result = await manager.compactContext(threadId, "admin");

  assert.equal(session.compactCalls, 1);
  assert.deepEqual(result, {
    tokensRemoved: 18_000,
    messagesRemoved: 8,
    contextUsage: { usedTokens: 12_000, maxTokens: 128_000 },
  });
  assert.deepEqual(store.getThread(threadId)?.contextUsage, result.contextUsage);
  assert.deepEqual(
    emitted.find((event) => event.kind === "context.usage"),
    { kind: "context.usage", usage: result.contextUsage },
  );
});

test("rejects manual compaction while a turn is running", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  const session = new FakeSession();
  const manager = new CopilotManager(
    () => new FakeClient(session) as unknown as CopilotClient,
  );
  t.after(() => manager.shutdown());

  await manager.sendMessage(threadId, "继续处理");
  await assert.rejects(manager.compactContext(threadId, "admin"), /仍在运行/);
  assert.equal(session.compactCalls, 0);
});

test("restores context usage from stored thread metadata", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId);
  store.threads[0]!.contextUsage = { usedTokens: 8_192, maxTokens: 64_000 };
  const manager = new CopilotManager(
    () => new FakeClient(new FakeSession()) as unknown as CopilotClient,
  );
  t.after(() => manager.shutdown());

  const snapshot = await manager.subscribe(threadId);
  assert.equal(snapshot.kind, "snapshot");
  if (snapshot.kind !== "snapshot") return;
  assert.deepEqual(snapshot.contextUsage, { usedTokens: 8_192, maxTokens: 64_000 });
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

test("restores subagent history and enriches child events that precede lifecycle metadata", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId, Date.now() - 10_000);
  const history = [
    sessionEvent("user.message", { content: "探索代码" }),
    sessionEvent("tool.execution_start", {
      toolCallId: "task-history",
      toolName: "task",
      arguments: {
        description: "检查存储层",
        prompt: "检查存储层恢复行为",
        agent_type: "explore",
      },
    }),
    sessionEvent(
      "user.message",
      { content: "检查存储层恢复行为" },
      "history-agent",
    ),
    sessionEvent(
      "assistant.message",
      { messageId: "child-history-message", content: "存储层使用 JSON 回退" },
      "history-agent",
    ),
    sessionEvent(
      "tool.execution_start",
      {
        toolCallId: "child-history-tool",
        toolName: "read_file",
        arguments: { path: "src/store.ts" },
      },
      "history-agent",
    ),
    sessionEvent(
      "subagent.started",
      {
        toolCallId: "task-history",
        agentName: "explore",
        agentDisplayName: "Explore",
        agentDescription: "代码库探索代理",
      },
      "history-agent",
    ),
    sessionEvent(
      "tool.execution_complete",
      {
        toolCallId: "child-history-tool",
        success: true,
        result: { content: "store source" },
      },
      "history-agent",
    ),
    sessionEvent(
      "subagent.completed",
      {
        toolCallId: "task-history",
        agentName: "explore",
        agentDisplayName: "Explore",
        totalToolCalls: 1,
      },
      "history-agent",
    ),
    sessionEvent("tool.execution_complete", {
      toolCallId: "task-history",
      success: true,
      result: { content: "done" },
    }),
  ];
  const session = new FakeSession(history);
  const manager = new CopilotManager(
    () => new FakeClient(session) as unknown as CopilotClient,
  );
  t.after(() => manager.shutdown());

  const snapshot = await manager.subscribe(threadId);
  assert.equal(snapshot.kind, "snapshot");
  if (snapshot.kind !== "snapshot") return;
  const subagent = snapshot.subagents?.[0];
  assert.equal(subagent?.id, "history-agent");
  assert.equal(subagent?.toolCallId, "task-history");
  assert.equal(subagent?.agentDescription, "代码库探索代理");
  assert.equal(subagent?.taskDescription, "检查存储层");
  assert.equal(subagent?.prompt, "检查存储层恢复行为");
  assert.equal(subagent?.status, "complete");
  assert.deepEqual(
    subagent?.messages.map((message) => [message.role, message.text]),
    [
      ["user", "检查存储层恢复行为"],
      ["assistant", "存储层使用 JSON 回退"],
    ],
  );
  assert.equal(subagent?.activities[0]?.status, "complete");
  assert.deepEqual(snapshot.activities.map((activity) => activity.id), ["task-history"]);
});

test("marks a previously idle background agent interrupted after session resume", async (t) => {
  const threadId = randomUUID();
  setupStore(t, threadId, Date.now() - 10_000);
  const history = [
    sessionEvent("user.message", { content: "启动后台检查" }),
    sessionEvent("tool.execution_start", {
      toolCallId: "idle-task",
      toolName: "task",
      arguments: {
        description: "后台检查",
        prompt: "检查服务端",
        agent_type: "explore",
        mode: "background",
      },
    }),
    sessionEvent("subagent.started", {
      toolCallId: "idle-task",
      agentName: "explore",
      agentDisplayName: "Explore",
      agentDescription: "代码库探索代理",
    }, "idle-agent"),
    sessionEvent("user.message", { content: "检查服务端" }, "idle-agent"),
    sessionEvent("assistant.message", {
      messageId: "idle-answer",
      content: "第一轮检查完成",
    }, "idle-agent"),
    sessionEvent("system.notification", {
      content: "后台代理正在等待",
      kind: {
        type: "agent_idle",
        agentId: "idle-agent",
        agentType: "explore",
        description: "后台检查",
      },
    }),
  ];
  const manager = new CopilotManager(
    () => new FakeClient(new FakeSession(history)) as unknown as CopilotClient,
  );
  t.after(() => manager.shutdown());

  const snapshot = await manager.subscribe(threadId);
  assert.equal(snapshot.kind, "snapshot");
  if (snapshot.kind !== "snapshot") return;
  assert.equal(snapshot.subagents?.[0]?.status, "cancelled");
  assert.equal(snapshot.subagents?.[0]?.error, "子代理执行已中断");
  assert.deepEqual(
    snapshot.subagents?.[0]?.messages.map((message) => message.role),
    ["user", "assistant"],
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
    includeSubAgentStreamingEvents?: boolean;
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
  assert.equal(config.includeSubAgentStreamingEvents, true);
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
