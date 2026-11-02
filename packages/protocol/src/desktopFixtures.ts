import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { ClientMessage, ModelOption, ServerMessage, ThreadMeta } from "./index.js";

const model = { providerId: "custom", modelId: "model-1", reasoningEffort: "high" } as const;
const thread = {
  id: "thread-1", projectId: "workspace-1", title: "原生客户端测试", runtime: "codex",
  model, createdAt: 1, updatedAt: 2, archived: false, access: "owner",
} satisfies ThreadMeta;
const message = {
  id: "message-1", role: "assistant", text: "你好，云端", turnId: "turn-1", createdAt: 1,
} as const;
const activity = {
  id: "tool-1", turnId: "turn-1", toolName: "exec_command", status: "running", args: "pwd", startedAt: 1,
} as const;
const models = [{ ref: model, label: "自定义模型" }] satisfies ModelOption[];
const client = [
  { id: "contract", type: "shell.subscribe" },
  { id: "contract", type: "models.list" },
  { id: "contract", type: "workspace.create", name: "云端项目" },
  { id: "contract", type: "thread.subscribe", threadId: thread.id },
  { id: "contract", type: "thread.unsubscribe", threadId: thread.id },
  { id: "contract", type: "thread.create", projectId: thread.projectId, runtime: "codex", agentMode: "standard", permissionMode: "request" },
  { id: "contract", type: "thread.create", projectId: thread.projectId, runtime: "dsh", model, agentMode: "standard", permissionMode: "request" },
  { id: "contract", type: "turn.start", threadId: thread.id, text: "你好" },
  { id: "contract", type: "turn.start", threadId: thread.id, text: "看这个文件", attachments: [{ path: "uploads/user/notes.md", displayName: "notes.md", fileId: "file-1" }] },
  { id: "contract", type: "thread.setPinned", threadId: thread.id, pinned: true },
  { id: "contract", type: "thread.delete", threadId: thread.id },
  { id: "contract", type: "turn.interrupt", threadId: thread.id },
  { id: "contract", type: "permission.respond", threadId: thread.id, requestId: "permission-1", decision: "accept" },
  { id: "contract", type: "permission.respond", threadId: thread.id, requestId: "permission-1", decision: "decline" },
] satisfies ClientMessage[];
const server = [
  { type: "auth.user", user: { username: "test-user", role: "user" } },
  { type: "shell", data: { projects: [{ id: thread.projectId, name: "云端项目" }], threads: [thread], runningThreadIds: [thread.id] } },
  { type: "reply", id: "models", ok: true, data: models },
  { type: "reply", id: "create", ok: true, data: thread },
  { type: "reply", id: "rejected", ok: false, error: "无权访问该会话" },
  { type: "thread.event", threadId: thread.id, event: { kind: "snapshot", messages: [], activities: [], running: true, live: { text: "", reasoning: "", turnId: "turn-1", startedAt: 1 } } },
  { type: "thread.event", threadId: thread.id, event: { kind: "turn.start", turnId: "turn-1", startedAt: 1 } },
  { type: "thread.event", threadId: thread.id, event: { kind: "user.message", message: { ...message, id: "user-1", role: "user", text: "你好" } } },
  { type: "thread.event", threadId: thread.id, event: { kind: "assistant.reasoning_delta", messageId: message.id, turnId: message.turnId, delta: "思考" } },
  { type: "thread.event", threadId: thread.id, event: { kind: "assistant.delta", messageId: message.id, turnId: message.turnId, delta: "你好，云端" } },
  { type: "thread.event", threadId: thread.id, event: { kind: "tool.start", activity } },
  { type: "thread.event", threadId: thread.id, event: { kind: "tool.complete", activity: { ...activity, status: "complete", result: "/workspace", endedAt: 2 } } },
  { type: "thread.event", threadId: thread.id, event: { kind: "permission.request", request: { requestId: "permission-1", kind: "command", command: "pwd", reason: "执行命令", cwd: "/workspace" } } },
  { type: "thread.event", threadId: thread.id, event: { kind: "permission.resolve", requestId: "permission-1", decision: "accept" } },
  { type: "thread.event", threadId: thread.id, event: { kind: "assistant.message", message } },
  { type: "thread.event", threadId: thread.id, event: { kind: "turn.end", turnId: "turn-1" } },
  { type: "thread.event", threadId: thread.id, event: { kind: "title", title: "完成" } },
  { type: "settings", data: { providers: [], connectors: [], mcpServers: [], skillDirectories: [], disabledSkills: [] } },
  { type: "auth.error", message: "未授权" },
] satisfies ServerMessage[];

const directory = new URL("../../../apps/desktop-gpui/tests/fixtures/", import.meta.url);
const destination = new URL("protocol.json", directory);
const expected = `${JSON.stringify({ client, server }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const actual = await readFile(destination, "utf8");
  if (actual !== expected) throw new Error("原生协议样例已过期，请运行 npm run desktop:native:protocol");
  console.log("原生协议样例与 @cca/protocol 一致");
} else {
  await mkdir(directory, { recursive: true });
  await writeFile(destination, expected);
  console.log("已生成原生协议样例");
}
