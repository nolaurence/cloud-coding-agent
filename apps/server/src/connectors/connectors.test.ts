import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectorConfig, Project, ThreadEvent } from "@cca/protocol";
import type { CopilotManager } from "../copilot.js";
import { store } from "../store.js";
import { ConnectorManager } from "./manager.js";
import type { ConnectorClientCallbacks, ConnectorTarget } from "./types.js";
import { normalizeFeishuMessage, parseFeishuText } from "./feishu.js";
import { normalizeQQMessage } from "./qq.js";

const TEST_PROJECT = {
  id: "project-1",
  name: "Project",
  path: process.cwd(),
  ownerId: "admin",
} satisfies Project;

test("QQ 消息事件归一化会保留会话和回复目标", () => {
  assert.deepEqual(
    normalizeQQMessage("GROUP_AT_MESSAGE_CREATE", {
      id: "message-1",
      content: "  帮我检查代码  ",
      group_openid: "group-1",
      author: { member_openid: "user-1" },
    }),
    {
      eventId: "message-1",
      messageId: "message-1",
      conversationId: "group:group-1",
      conversationLabel: "QQ群 group-1",
      senderId: "user-1",
      text: "帮我检查代码",
      target: { platform: "qq", kind: "group", id: "group-1" },
    },
  );
});

test("飞书文本和富文本消息可提取为纯文本", () => {
  assert.equal(parseFeishuText("text", JSON.stringify({ text: " 你好 " })), "你好");
  assert.equal(
    parseFeishuText("post", JSON.stringify({ zh_cn: { title: "标题", content: [[{ tag: "text", text: "第一行" }, { tag: "text", text: "第二行" }]] } })),
    "第一行\n第二行",
  );
});

test("飞书消息按 chat_id 映射外部会话", () => {
  assert.deepEqual(
    normalizeFeishuMessage({
      event_id: "event-1",
      sender: { sender_id: { open_id: "open-user" } },
      message: {
        message_id: "message-1",
        chat_id: "chat-1",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "开始任务" }),
      },
    }),
    {
      eventId: "event-1",
      messageId: "message-1",
      conversationId: "chat:chat-1",
      conversationLabel: "飞书群聊 chat-1",
      senderId: "open-user",
      text: "开始任务",
      target: { platform: "feishu", kind: "chat", id: "chat-1" },
    },
  );
});

test("连接器会去重消息、复用映射会话并回传完整回复", async (t) => {
  const previousProjects = store.projects;
  const previousThreads = store.threads;
  const previousUpsertThread = store.upsertThread;
  store.projects = [{ ...TEST_PROJECT }];
  store.threads = [];
  store.upsertThread = (thread) => {
    const index = store.threads.findIndex((candidate) => candidate.id === thread.id);
    if (index >= 0) store.threads[index] = thread;
    else store.threads.push(thread);
  };
  t.after(() => {
    store.projects = previousProjects;
    store.threads = previousThreads;
    store.upsertThread = previousUpsertThread;
  });

  let sink: ((threadId: string, event: ThreadEvent) => void) | undefined;
  let callbacks: ConnectorClientCallbacks | undefined;
  let subscriptions = 0;
  let unsubscriptions = 0;
  const sent: Array<{ target: ConnectorTarget; text: string }> = [];
  const fakeManager = {
    onThreadEvent(next: typeof sink) { sink = next; },
    async subscribe() { subscriptions += 1; return { kind: "snapshot", messages: [], activities: [], running: false }; },
    unsubscribe() { unsubscriptions += 1; },
    async sendMessage(threadId: string) {
      sink?.(threadId, {
        kind: "assistant.message",
        message: { id: "assistant-1", role: "assistant", text: "任务完成", turnId: "turn-1", createdAt: Date.now() },
      });
      sink?.(threadId, { kind: "turn.end", turnId: "turn-1" });
    },
  } as unknown as CopilotManager;
  const config: ConnectorConfig = {
    id: "qq-1",
    name: "QQ 助手",
    platform: "qq",
    enabled: true,
    appId: "app",
    appSecret: "secret",
    projectId: "project-1",
    model: { providerId: "copilot", modelId: "model-1" },
    ownerId: "admin",
  };
  const manager = new ConnectorManager(fakeManager, () => {}, () => {}, {
    qq: (_config, nextCallbacks) => {
      callbacks = nextCallbacks;
      return {
        async start() { nextCallbacks.onStatus("connected"); },
        async stop() {},
        async send(target, text) { sent.push({ target, text }); },
      };
    },
    feishu: () => { throw new Error("not used"); },
  });
  await manager.applySettings([config]);
  const message = {
    eventId: "event-1",
    messageId: "message-1",
    conversationId: "private:user-1",
    conversationLabel: "QQ 私聊 user-1",
    senderId: "user-1",
    text: "执行任务",
    target: { platform: "qq", kind: "private", id: "user-1" } as const,
  };
  await callbacks!.onMessage(message);
  await callbacks!.onMessage(message);

  assert.equal(store.threads.length, 1);
  assert.equal(subscriptions, 1);
  assert.equal(unsubscriptions, 1);
  assert.deepEqual(sent, [{ target: message.target, text: "任务完成" }]);
  await manager.shutdown();
});

test("连接器配置切换模型后为同一外部聊天创建新会话", async (t) => {
  const previousProjects = store.projects;
  const previousThreads = store.threads;
  const previousUpsertThread = store.upsertThread;
  store.projects = [{ ...TEST_PROJECT }];
  store.threads = [];
  store.upsertThread = (thread) => {
    const index = store.threads.findIndex((candidate) => candidate.id === thread.id);
    if (index >= 0) store.threads[index] = thread;
    else store.threads.push(thread);
  };
  t.after(() => {
    store.projects = previousProjects;
    store.threads = previousThreads;
    store.upsertThread = previousUpsertThread;
  });

  let sink: ((threadId: string, event: ThreadEvent) => void) | undefined;
  let callbacks: ConnectorClientCallbacks | undefined;
  const fakeManager = {
    onThreadEvent(next: typeof sink) { sink = next; },
    async subscribe() { return { kind: "snapshot", messages: [], activities: [], running: false }; },
    unsubscribe() {},
    async sendMessage(threadId: string) {
      sink?.(threadId, { kind: "assistant.message", message: { id: randomId(), role: "assistant", text: "ok", turnId: "turn", createdAt: Date.now() } });
      sink?.(threadId, { kind: "turn.end", turnId: "turn" });
    },
  } as unknown as CopilotManager;
  const factory = (_config: ConnectorConfig, nextCallbacks: ConnectorClientCallbacks) => {
    callbacks = nextCallbacks;
    return { async start() {}, async stop() {}, async send() {} };
  };
  const manager = new ConnectorManager(fakeManager, () => {}, () => {}, { qq: factory, feishu: factory });
  const base: ConnectorConfig = {
    id: "qq-1", name: "QQ 助手", platform: "qq", enabled: true, appId: "app", appSecret: "secret",
    projectId: "project-1", model: { providerId: "copilot", modelId: "model-1" }, ownerId: "admin",
  };
  const message = {
    eventId: "event-1", messageId: "message-1", conversationId: "private:user-1",
    conversationLabel: "QQ 私聊 user-1", senderId: "user-1", text: "第一条",
    target: { platform: "qq", kind: "private", id: "user-1" } as const,
  };
  await manager.applySettings([base]);
  await callbacks!.onMessage(message);
  await manager.applySettings([{ ...base, model: { providerId: "copilot", modelId: "model-2" } }]);
  await callbacks!.onMessage({ ...message, eventId: "event-2", messageId: "message-2" });

  assert.equal(store.threads.length, 2);
  assert.deepEqual(store.threads.map((thread) => thread.model?.modelId), ["model-1", "model-2"]);
  await manager.shutdown();
});

test("运行中任务在热更新后使用新客户端回复", async (t) => {
  const previousProjects = store.projects;
  const previousThreads = store.threads;
  const previousUpsertThread = store.upsertThread;
  store.projects = [{ ...TEST_PROJECT }];
  store.threads = [];
  store.upsertThread = (thread) => {
    const index = store.threads.findIndex((candidate) => candidate.id === thread.id);
    if (index >= 0) store.threads[index] = thread;
    else store.threads.push(thread);
  };

  let sink: ((threadId: string, event: ThreadEvent) => void) | undefined;
  let activeThreadId = "";
  let markStarted!: () => void;
  let releaseSend!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const sendReleased = new Promise<void>((resolve) => { releaseSend = resolve; });
  const callbacks: ConnectorClientCallbacks[] = [];
  const stoppedClients: string[] = [];
  const replies: string[] = [];
  const fakeManager = {
    onThreadEvent(next: typeof sink) {
      sink = next;
      return () => { sink = undefined; };
    },
    async subscribe() { return { kind: "snapshot", messages: [], activities: [], running: false }; },
    unsubscribe() {},
    async sendMessage(threadId: string) {
      activeThreadId = threadId;
      markStarted();
      await sendReleased;
    },
  } as unknown as CopilotManager;
  const factory = (config: ConnectorConfig, nextCallbacks: ConnectorClientCallbacks) => {
    const clientName = config.appSecret;
    callbacks.push(nextCallbacks);
    return {
      async start() {},
      async stop() { stoppedClients.push(clientName); },
      async send(_target: ConnectorTarget, text: string) { replies.push(`${clientName}:${text}`); },
    };
  };
  const manager = new ConnectorManager(fakeManager, () => {}, () => {}, { qq: factory, feishu: factory });
  t.after(async () => {
    await manager.shutdown();
    store.projects = previousProjects;
    store.threads = previousThreads;
    store.upsertThread = previousUpsertThread;
  });
  const config: ConnectorConfig = {
    id: "qq-1", name: "QQ 助手", platform: "qq", enabled: true, appId: "app", appSecret: "old",
    projectId: "project-1", model: { providerId: "copilot", modelId: "model-1" }, ownerId: "admin",
  };
  const message = {
    eventId: "event-1", messageId: "message-1", conversationId: "private:user-1",
    conversationLabel: "QQ 私聊 user-1", senderId: "user-1", text: "执行任务",
    target: { platform: "qq", kind: "private", id: "user-1" } as const,
  };

  await manager.applySettings([config]);
  const processing = callbacks[0]!.onMessage(message);
  await started;
  await manager.applySettings([{ ...config, appSecret: "new" }]);
  sink?.(activeThreadId, {
    kind: "assistant.message",
    message: { id: "assistant-1", role: "assistant", text: "热更新完成", turnId: "turn-1", createdAt: Date.now() },
  });
  sink?.(activeThreadId, { kind: "turn.end", turnId: "turn-1" });
  releaseSend();
  await processing;

  assert.deepEqual(stoppedClients, ["old"]);
  assert.deepEqual(replies, ["new:热更新完成"]);
});

test("启用的连接器必须关联所有者自己的工作区", async (t) => {
  const previousProjects = store.projects;
  store.projects = [{ id: "project-1", name: "Project", path: process.cwd(), ownerId: "workspace-owner" }];
  t.after(() => { store.projects = previousProjects; });

  const fakeManager = { onThreadEvent() { return () => {}; } } as unknown as CopilotManager;
  const factory = () => ({ async start() {}, async stop() {}, async send() {} });
  const manager = new ConnectorManager(fakeManager, () => {}, () => {}, { qq: factory, feishu: factory });
  t.after(() => manager.shutdown());

  const config: ConnectorConfig = {
    id: "qq-1",
    name: "QQ 助手",
    platform: "qq",
    enabled: true,
    appId: "app",
    appSecret: "secret",
    projectId: "project-1",
    model: { providerId: "copilot", modelId: "model-1" },
    ownerId: "other-user",
  };
  await assert.rejects(manager.applySettings([config]), /工作区与所有者不匹配/);
});

function randomId(): string {
  return Math.random().toString(36).slice(2);
}
