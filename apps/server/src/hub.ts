import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import type {
  ClientMessage,
  ServerMessage,
  ShellState,
  ThreadMeta,
} from "@cca/protocol";
import { store } from "./store.js";
import { CopilotManager } from "./copilot.js";
import { searchFiles } from "./files.js";
import { deleteSkill, listSkills, saveSkill } from "./skills.js";
import { flattenModels } from "@cca/protocol";

interface ClientConn {
  socket: WebSocket;
  shellSubscribed: boolean;
  threadSubs: Set<string>;
}

export class Hub {
  private clients = new Set<ClientConn>();
  private manager = new CopilotManager();

  constructor() {
    this.manager.onThreadEvent((threadId, event) => {
      this.broadcastThread(threadId, event);
    });
    this.manager.onShellChanged(() => {
      this.broadcastShell();
    });
  }

  handleConnection(socket: WebSocket) {
    const conn: ClientConn = { socket, shellSubscribed: false, threadSubs: new Set() };
    this.clients.add(conn);
    socket.on("message", (raw) => {
      void this.onMessage(conn, raw.toString()).catch((err) => {
        console.error("message error", err);
      });
    });
    socket.on("close", () => {
      for (const threadId of conn.threadSubs) {
        this.manager.unsubscribe(threadId);
      }
      this.clients.delete(conn);
    });
  }

  private send(conn: ClientConn, msg: ServerMessage) {
    if (conn.socket.readyState === conn.socket.OPEN) {
      conn.socket.send(JSON.stringify(msg));
    }
  }

  private reply(conn: ClientConn, id: string, data?: unknown) {
    this.send(conn, { type: "reply", id, ok: true, data });
  }

  private replyError(conn: ClientConn, id: string, error: unknown) {
    this.send(conn, {
      type: "reply",
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  private shellState(): ShellState {
    return {
      projects: store.projects,
      threads: [...store.threads].sort((a, b) => b.updatedAt - a.updatedAt),
      runningThreadIds: this.manager.runningThreadIds(),
    };
  }

  broadcastShell() {
    const state = this.shellState();
    for (const conn of this.clients) {
      if (conn.shellSubscribed) this.send(conn, { type: "shell", data: state });
    }
  }

  private broadcastThread(threadId: string, event: import("@cca/protocol").ThreadEvent) {
    for (const conn of this.clients) {
      if (conn.threadSubs.has(threadId)) {
        this.send(conn, { type: "thread.event", threadId, event });
      }
    }
  }

  private broadcastSettings() {
    for (const conn of this.clients) {
      if (conn.shellSubscribed) this.send(conn, { type: "settings", data: store.settings });
    }
  }

  private broadcastSkills() {
    const skills = listSkills();
    for (const conn of this.clients) {
      if (conn.shellSubscribed) this.send(conn, { type: "skills", data: skills });
    }
  }

  private async onMessage(conn: ClientConn, raw: string) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }

    try {
      switch (msg.type) {
        case "shell.subscribe": {
          conn.shellSubscribed = true;
          this.send(conn, { type: "shell", data: this.shellState() });
          this.send(conn, { type: "settings", data: store.settings });
          this.send(conn, { type: "skills", data: listSkills() });
          this.reply(conn, msg.id);
          break;
        }
        case "project.add": {
          const name = msg.name?.trim() || msg.path.split(/[\\/]/).filter(Boolean).pop() || msg.path;
          const project = { id: randomUUID(), name, path: msg.path };
          store.addProject(project);
          this.broadcastShell();
          this.reply(conn, msg.id, project);
          break;
        }
        case "project.remove": {
          store.removeProject(msg.projectId);
          this.broadcastShell();
          this.reply(conn, msg.id);
          break;
        }
        case "thread.create": {
          const thread: ThreadMeta = {
            id: randomUUID(),
            projectId: msg.projectId,
            title: "新会话",
            model: msg.model ?? store.settings.defaultModel,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            archived: false,
          };
          store.upsertThread(thread);
          this.broadcastShell();
          this.reply(conn, msg.id, thread);
          break;
        }
        case "thread.delete": {
          await this.manager.deleteThread(msg.threadId);
          store.deleteThread(msg.threadId);
          this.broadcastShell();
          this.reply(conn, msg.id);
          break;
        }
        case "thread.setModel": {
          const thread = store.getThread(msg.threadId);
          if (!thread) throw new Error("会话不存在");
          store.upsertThread({ ...thread, model: msg.model });
          await this.manager.deleteThread(msg.threadId);
          this.broadcastShell();
          this.reply(conn, msg.id);
          break;
        }
        case "thread.subscribe": {
          const snapshot = await this.manager.subscribe(msg.threadId);
          conn.threadSubs.add(msg.threadId);
          this.send(conn, { type: "thread.event", threadId: msg.threadId, event: snapshot });
          this.reply(conn, msg.id);
          break;
        }
        case "thread.unsubscribe": {
          conn.threadSubs.delete(msg.threadId);
          this.manager.unsubscribe(msg.threadId);
          this.reply(conn, msg.id);
          break;
        }
        case "turn.start": {
          this.reply(conn, msg.id);
          await this.manager.sendMessage(msg.threadId, msg.text, msg.attachments);
          this.broadcastShell();
          break;
        }
        case "turn.interrupt": {
          await this.manager.interrupt(msg.threadId);
          this.reply(conn, msg.id);
          break;
        }
        case "settings.get": {
          this.reply(conn, msg.id, store.settings);
          break;
        }
        case "settings.update": {
          const prev = store.settings;
          store.saveSettings(msg.settings);
          const providerChanged =
            JSON.stringify(prev.providers) !== JSON.stringify(msg.settings.providers) ||
            JSON.stringify(prev.mcpServers) !== JSON.stringify(msg.settings.mcpServers) ||
            JSON.stringify(prev.disabledSkills) !== JSON.stringify(msg.settings.disabledSkills) ||
            JSON.stringify(prev.skillDirectories) !== JSON.stringify(msg.settings.skillDirectories);
          if (providerChanged) {
            await this.manager.reconfigureOpenSessions();
          }
          this.broadcastSettings();
          this.broadcastSkills();
          this.reply(conn, msg.id);
          break;
        }
        case "skills.list": {
          this.reply(conn, msg.id, listSkills());
          break;
        }
        case "skill.save": {
          saveSkill(msg.name, msg.description, msg.content);
          this.broadcastSkills();
          this.reply(conn, msg.id);
          break;
        }
        case "skill.delete": {
          deleteSkill(msg.name);
          this.broadcastSkills();
          this.reply(conn, msg.id);
          break;
        }
        case "models.list": {
          const configured = flattenModels(store.settings);
          let copilotModels: { ref: { providerId: string; modelId: string }; label: string }[] = [];
          try {
            const models = await this.manager.listModels();
            copilotModels = models.map((m) => ({
              ref: { providerId: "copilot", modelId: m.id },
              label: `GitHub Copilot / ${m.name ?? m.id}`,
            }));
          } catch {
            // copilot auth not available; ignore
          }
          this.reply(conn, msg.id, [...configured, ...copilotModels]);
          break;
        }
        case "files.search": {
          const project = store.projects.find((p) => p.id === msg.projectId);
          if (!project) throw new Error("项目不存在");
          this.reply(conn, msg.id, searchFiles(project.path, msg.query));
          break;
        }
        default: {
          this.replyError(conn, (msg as { id?: string }).id ?? "", "未知消息类型");
        }
      }
    } catch (err) {
      this.replyError(conn, msg.id, err);
    }
  }

  async shutdown() {
    await this.manager.shutdown();
  }
}
