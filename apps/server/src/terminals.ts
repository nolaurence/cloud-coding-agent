import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { TerminalEvent } from "@cca/protocol";

interface TerminalSession {
  id: string;
  threadId: string;
  ownerId: string;
  cwd: string;
  process: ChildProcessWithoutNullStreams;
  history: string;
}

const MAX_HISTORY = 200_000;

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();

  constructor(private readonly emit: (ownerId: string, event: TerminalEvent) => void) {}

  open(ownerId: string, threadId: string, terminalId: string, cwd: string) {
    const existing = this.sessions.get(terminalId);
    if (existing) {
      if (existing.ownerId !== ownerId || existing.threadId !== threadId) throw new Error("无权访问该终端");
      return { terminalId, cwd: existing.cwd, history: existing.history, running: true };
    }
    if (!/^[\w.-]{1,128}$/.test(terminalId)) throw new Error("终端标识无效");
    const shell = process.env.SHELL || "/bin/sh";
    const child = spawn(shell, ["-i"], {
      cwd,
      env: { ...process.env, TERM: "xterm-256color" },
      stdio: "pipe",
    });
    const session: TerminalSession = { id: terminalId, threadId, ownerId, cwd, process: child, history: "" };
    this.sessions.set(terminalId, session);
    const output = (chunk: Buffer) => {
      const data = chunk.toString("utf8");
      session.history = (session.history + data).slice(-MAX_HISTORY);
      this.emit(ownerId, { kind: "output", terminalId, data });
    };
    child.stdout.on("data", output);
    child.stderr.on("data", output);
    child.on("error", (error) => output(Buffer.from(`\r\n${error.message}\r\n`)));
    child.on("exit", (code) => {
      this.sessions.delete(terminalId);
      this.emit(ownerId, { kind: "exit", terminalId, code });
    });
    return { terminalId, cwd, history: "", running: true };
  }

  write(ownerId: string, terminalId: string, data: string) {
    const session = this.sessions.get(terminalId);
    if (!session || session.ownerId !== ownerId) throw new Error("终端不存在");
    if (data.length > 65_536) throw new Error("终端输入过长");
    session.process.stdin.write(data);
  }

  close(ownerId: string, terminalId: string) {
    const session = this.sessions.get(terminalId);
    if (!session || session.ownerId !== ownerId) return;
    this.sessions.delete(terminalId);
    session.process.kill("SIGTERM");
  }

  closeThread(threadId: string) {
    for (const session of this.sessions.values()) {
      if (session.threadId === threadId) this.close(session.ownerId, session.id);
    }
  }

  shutdown() {
    for (const session of [...this.sessions.values()]) this.close(session.ownerId, session.id);
  }
}
