import assert from "node:assert/strict";
import test from "node:test";
import type { TerminalEvent } from "@cca/protocol";
import { TerminalManager, type TerminalSpawner } from "./terminals.js";

class FakeTerminal {
  writes: string[] = [];
  resizes: Array<{ cols: number; rows: number }> = [];
  killed = false;
  private dataListener?: (data: string) => void;
  private exitListener?: (event: { exitCode: number; signal?: number }) => void;

  onData(listener: (data: string) => void) {
    this.dataListener = listener;
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListener = listener;
  }

  write(data: string) {
    this.writes.push(data);
  }

  resize(cols: number, rows: number) {
    this.resizes.push({ cols, rows });
  }

  kill() {
    this.killed = true;
  }

  emitData(data: string) {
    this.dataListener?.(data);
  }

  emitExit(exitCode: number, signal?: number) {
    this.exitListener?.({ exitCode, ...(signal === undefined ? {} : { signal }) });
  }
}

function fixture() {
  const processes: FakeTerminal[] = [];
  const spawnCalls: Array<{ file: string; args: string[]; options: Parameters<TerminalSpawner>[2] }> = [];
  const events: Array<{ ownerId: string; event: TerminalEvent }> = [];
  const spawn: TerminalSpawner = (file, args, options) => {
    const process = new FakeTerminal();
    processes.push(process);
    spawnCalls.push({ file, args, options });
    return process;
  };
  const manager = new TerminalManager(
    (ownerId, event) => events.push({ ownerId, event }),
    spawn,
  );
  return { manager, processes, spawnCalls, events };
}

test("terminal sessions stream PTY data, retain history, accept input and resize", () => {
  const { manager, processes, spawnCalls, events } = fixture();
  const opened = manager.open("alice", "thread-1", "term-1", "/workspace", 120, 40);

  assert.deepEqual(opened, {
    terminalId: "term-1",
    cwd: "/workspace",
    history: "",
    running: true,
    cols: 120,
    rows: 40,
  });
  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0]?.options.cwd, "/workspace");
  assert.equal(spawnCalls[0]?.options.name, "xterm-256color");
  assert.equal(spawnCalls[0]?.options.env.TERM, "xterm-256color");

  processes[0]?.emitData("\u001b[32mready\u001b[0m\r\n");
  assert.deepEqual(events, [
    {
      ownerId: "alice",
      event: { kind: "output", terminalId: "term-1", data: "\u001b[32mready\u001b[0m\r\n" },
    },
  ]);
  assert.equal(manager.open("alice", "thread-1", "term-1", "/workspace", 120, 40).history, "\u001b[32mready\u001b[0m\r\n");
  assert.equal(spawnCalls.length, 1);

  manager.write("alice", "term-1", "npm test\r");
  manager.resize("alice", "term-1", 90, 25);
  assert.deepEqual(processes[0]?.writes, ["npm test\r"]);
  assert.deepEqual(processes[0]?.resizes, [{ cols: 90, rows: 25 }]);
  assert.deepEqual(manager.open("alice", "thread-1", "term-1", "/workspace"), {
    terminalId: "term-1",
    cwd: "/workspace",
    history: "\u001b[32mready\u001b[0m\r\n",
    running: true,
    cols: 90,
    rows: 25,
  });
  assert.deepEqual(processes[0]?.resizes, [{ cols: 90, rows: 25 }]);
});

test("late exit from a closed terminal cannot delete a replacement with the same id", () => {
  const { manager, processes, events } = fixture();
  manager.open("alice", "thread-1", "term-1", "/workspace");
  const first = processes[0];
  manager.close("alice", "term-1");
  assert.equal(first?.killed, true);

  manager.open("alice", "thread-1", "term-1", "/workspace");
  const replacement = processes[1];
  first?.emitData("stale output");
  first?.emitExit(0);
  manager.write("alice", "term-1", "echo still-running\r");

  assert.deepEqual(replacement?.writes, ["echo still-running\r"]);
  assert.deepEqual(events, []);

  replacement?.emitExit(7, 15);
  assert.deepEqual(events, [
    {
      ownerId: "alice",
      event: { kind: "exit", terminalId: "term-1", code: 7, signal: 15 },
    },
  ]);
  assert.throws(() => manager.write("alice", "term-1", "ignored"), /终端不存在/);
});

test("terminal ids are isolated by owner and dimensions are validated", () => {
  const { manager, processes } = fixture();
  manager.open("alice", "thread-1", "shared", "/workspace-a");
  manager.open("bob", "thread-2", "shared", "/workspace-b");
  manager.write("alice", "shared", "a");
  manager.write("bob", "shared", "b");

  assert.deepEqual(processes[0]?.writes, ["a"]);
  assert.deepEqual(processes[1]?.writes, ["b"]);
  assert.throws(() => manager.open("alice", "another-thread", "shared", "/workspace-a"), /无权访问/);
  assert.throws(() => manager.resize("alice", "shared", 0, 24), /终端列数/);
  assert.throws(() => manager.resize("alice", "shared", 80, 1000), /终端行数/);
  assert.throws(() => manager.open("alice", "thread-1", "invalid/id", "/workspace-a"), /终端标识/);
});
