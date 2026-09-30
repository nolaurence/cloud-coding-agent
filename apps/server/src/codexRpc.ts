import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { createRequire } from "node:module";
import path from "node:path";
import { object, text, type JsonObject } from "./llmGateway.js";

type CodexTarget = { packageName: string; triple: string };

function bundledCodexTarget(): CodexTarget {
  const targets: Record<string, CodexTarget> = {
    "win32-x64": { packageName: "@openai/codex-win32-x64", triple: "x86_64-pc-windows-msvc" },
    "win32-arm64": { packageName: "@openai/codex-win32-arm64", triple: "aarch64-pc-windows-msvc" },
    "darwin-x64": { packageName: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" },
    "darwin-arm64": { packageName: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" },
    "linux-x64": { packageName: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl" },
    "linux-arm64": { packageName: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" },
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) throw new Error(`Unsupported Codex platform: ${process.platform} (${process.arch})`);
  return target;
}

export function codexCommand(): { command: string; prefix: string[] } {
  if (process.env.CCA_CODEX_PATH) return { command: process.env.CCA_CODEX_PATH, prefix: [] };
  const require = createRequire(import.meta.url);
  const target = bundledCodexTarget();
  const packageJson = require.resolve(`${target.packageName}/package.json`);
  const executable = path.join(
    path.dirname(packageJson),
    "vendor",
    target.triple,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  return { command: executable.replace(/app\.asar([\\/])/, "app.asar.unpacked$1"), prefix: [] };
}

export class CodexRpc {
  private process: ChildProcessWithoutNullStreams | undefined;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: JsonObject): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private closing = false;
  private exit: Promise<void> | undefined;
  private listeners = new Set<(method: string, params: JsonObject) => void>();
  onFailure: (error: Error) => void = () => {};
  onRequest: (method: string, params: JsonObject) => Promise<JsonObject> = async (method) => { throw new Error("Unsupported Codex request: " + method); };

  onNotification(handler: (method: string, params: JsonObject) => void) {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }
  async start(cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    const binary = codexCommand();
    this.process = spawn(binary.command, [...binary.prefix, "app-server", "--listen", "stdio://"], {
      cwd,
      env,
      stdio: "pipe",
      windowsHide: true,
    });
    const child = this.process;
    this.exit = new Promise((resolve) => child.once("close", () => resolve()));
    child.once("error", (error) => this.fail(error));
    child.once("exit", (code, signal) => { if (!this.closing) this.fail(new Error("Codex exited: " + (signal ?? code))); });
    // stderr can contain provider URLs and credentials. Never forward it to clients or logs.
    child.stderr.resume();
    child.stdin.on("error", (error) => { if (!this.closing) this.fail(error); });
    const decoder = new StringDecoder("utf8");
    let pending = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.closing) return;
      try {
        pending += decoder.write(chunk);
        if (pending.length > 32 * 1024 * 1024) throw new Error("Codex RPC message too large");
        let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          this.receive(object(JSON.parse(line)));
        }
      } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    try {
      await this.request("initialize", { clientInfo: { name: "cloud-coding-agent", version: "0.1.0" }, capabilities: { experimentalApi: true } });
      this.write({ method: "initialized", params: {} });
    } catch (error) { await this.close(); throw error; }
  }
  private receive(message: JsonObject) {
    if (typeof message.method === "string") {
      const params = object(message.params ?? {});
      if (message.id !== undefined) {
        void this.onRequest(message.method, params).then(
          (result) => this.write({ id: message.id, result }),
          (error: unknown) => this.write({ id: message.id, error: { code: -32603, message: error instanceof Error ? error.message : "Tool execution failed" } }),
        ).catch((error: unknown) => this.fail(error instanceof Error ? error : new Error(String(error))));
      } else for (const handler of this.listeners) handler(message.method, params);
      return;
    }
    if (typeof message.id !== "number") throw new Error("Invalid Codex RPC response id");
    const pending = this.pending.get(message.id);
    if (!pending) return; // A timed-out request can still receive a late reply.
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(text(object(message.error).message)));
    else pending.resolve(object(message.result ?? {}));
  }
  private write(message: JsonObject) {
    if (this.closing || !this.process?.stdin.writable) throw new Error("Codex connection is closed");
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }
  request(method: string, params: JsonObject, timeout = 60_000): Promise<JsonObject> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Codex RPC timed out: " + method)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    if (!this.closing) {
      this.closing = true;
      try { this.onFailure(error); } finally { this.process?.kill("SIGKILL"); }
    }
  }
  async close() {
    this.closing = true;
    this.fail(new Error("Codex connection closed"));
    if (!this.process || this.process.exitCode !== null || this.process.signalCode !== null) return;
    this.process.stdin.end();
    this.process.kill("SIGTERM");
    const timer = setTimeout(() => this.process?.kill("SIGKILL"), 3000);
    try { await this.exit; } finally { clearTimeout(timer); }
  }
}
