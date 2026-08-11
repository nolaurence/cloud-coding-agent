import { createRequire } from "node:module";
import type { TerminalEvent, TerminalSnapshot } from "@cca/protocol";

interface TerminalProcess {
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface TerminalSpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type TerminalSpawner = (
  file: string,
  args: string[],
  options: TerminalSpawnOptions,
) => TerminalProcess;

interface TerminalSession {
  id: string;
  threadId: string;
  ownerId: string;
  cwd: string;
  process: TerminalProcess;
  history: string;
  cols: number;
  rows: number;
}

const MAX_HISTORY = 200_000;
const MAX_INPUT = 65_536;
const MAX_TERMINALS_PER_OWNER = 10;
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;
const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 200;
const SAFE_ENVIRONMENT_KEYS = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMP",
  "TEMP",
  "TMPDIR",
] as const;

const require = createRequire(import.meta.url);
const defaultSpawner: TerminalSpawner = (file, args, options) => {
  const { spawn } = require("node-pty") as { spawn: TerminalSpawner };
  return spawn(file, args, options);
};

function terminalKey(ownerId: string, terminalId: string): string {
  return `${ownerId}\0${terminalId}`;
}

function dimensions(cols = DEFAULT_COLS, rows = DEFAULT_ROWS) {
  if (!Number.isInteger(cols) || cols < MIN_COLS || cols > MAX_COLS) {
    throw new Error(`终端列数必须在 ${MIN_COLS}-${MAX_COLS} 之间`);
  }
  if (!Number.isInteger(rows) || rows < MIN_ROWS || rows > MAX_ROWS) {
    throw new Error(`终端行数必须在 ${MIN_ROWS}-${MAX_ROWS} 之间`);
  }
  return { cols, rows };
}

function shellCommand(): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return { file: process.env.COMSPEC || "powershell.exe", args: [] };
  }
  return { file: process.env.SHELL || "/bin/sh", args: [] };
}

export function terminalEnvironment(
  cwd: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return {
    ...env,
    HOME: cwd,
    USERPROFILE: cwd,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    TERM_PROGRAM: "cloud-coding-agent",
  };
}

function snapshot(session: TerminalSession): TerminalSnapshot {
  return {
    terminalId: session.id,
    cwd: session.cwd,
    history: session.history,
    running: true,
    cols: session.cols,
    rows: session.rows,
  };
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();

  constructor(
    private readonly emit: (ownerId: string, event: TerminalEvent) => void,
    private readonly spawnTerminal: TerminalSpawner = defaultSpawner,
  ) {}

  open(
    ownerId: string,
    threadId: string,
    terminalId: string,
    cwd: string,
    requestedCols?: number,
    requestedRows?: number,
  ): TerminalSnapshot {
    if (!/^[\w.-]{1,128}$/.test(terminalId)) throw new Error("终端标识无效");
    const key = terminalKey(ownerId, terminalId);
    const existing = this.sessions.get(key);
    if (existing) {
      if (existing.threadId !== threadId) throw new Error("无权访问该终端");
      const { cols, rows } = dimensions(
        requestedCols ?? existing.cols,
        requestedRows ?? existing.rows,
      );
      if (existing.cols !== cols || existing.rows !== rows) {
        existing.process.resize(cols, rows);
        existing.cols = cols;
        existing.rows = rows;
      }
      return snapshot(existing);
    }

    const ownerSessionCount = [...this.sessions.values()].filter(
      (session) => session.ownerId === ownerId,
    ).length;
    if (ownerSessionCount >= MAX_TERMINALS_PER_OWNER) {
      throw new Error(`每个用户最多同时打开 ${MAX_TERMINALS_PER_OWNER} 个终端`);
    }

    const { cols, rows } = dimensions(requestedCols, requestedRows);
    const shell = shellCommand();
    const terminal = this.spawnTerminal(shell.file, shell.args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: terminalEnvironment(cwd),
    });
    const session: TerminalSession = {
      id: terminalId,
      threadId,
      ownerId,
      cwd,
      process: terminal,
      history: "",
      cols,
      rows,
    };
    this.sessions.set(key, session);

    terminal.onData((data) => {
      if (this.sessions.get(key) !== session) return;
      session.history = (session.history + data).slice(-MAX_HISTORY);
      this.emit(ownerId, { kind: "output", terminalId, data });
    });
    terminal.onExit(({ exitCode, signal }) => {
      // A closed PTY can report exit after a replacement has already reused the same ID.
      if (this.sessions.get(key) !== session) return;
      this.sessions.delete(key);
      this.emit(ownerId, {
        kind: "exit",
        terminalId,
        code: Number.isInteger(exitCode) ? exitCode : null,
        ...(signal === undefined ? {} : { signal }),
      });
    });

    return snapshot(session);
  }

  write(ownerId: string, terminalId: string, data: string) {
    const session = this.sessions.get(terminalKey(ownerId, terminalId));
    if (!session) throw new Error("终端不存在");
    if (data.length > MAX_INPUT) throw new Error("终端输入过长");
    session.process.write(data);
  }

  resize(ownerId: string, terminalId: string, requestedCols: number, requestedRows: number) {
    const session = this.sessions.get(terminalKey(ownerId, terminalId));
    if (!session) throw new Error("终端不存在");
    const { cols, rows } = dimensions(requestedCols, requestedRows);
    if (session.cols === cols && session.rows === rows) return;
    session.process.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
  }

  close(ownerId: string, terminalId: string) {
    const key = terminalKey(ownerId, terminalId);
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    try {
      session.process.kill();
    } catch {
      // The PTY may have exited between lookup and cleanup.
    }
  }

  closeThread(threadId: string) {
    for (const session of [...this.sessions.values()]) {
      if (session.threadId === threadId) this.close(session.ownerId, session.id);
    }
  }

  closeOwnerThread(ownerId: string, threadId: string) {
    for (const session of [...this.sessions.values()]) {
      if (session.ownerId === ownerId && session.threadId === threadId) {
        this.close(session.ownerId, session.id);
      }
    }
  }

  shutdown() {
    for (const session of [...this.sessions.values()]) this.close(session.ownerId, session.id);
  }
}
