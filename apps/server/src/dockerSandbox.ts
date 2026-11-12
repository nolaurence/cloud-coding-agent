import fs from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { DATA_DIR } from "./env.js";
import { isSandboxPathIgnored, SANDBOX_WORKSPACE_POLICY_VERSION } from "./dockerSandboxFiles.js";

export interface DockerSandboxConfig {
  host: string;
  username: string;
  port?: number;
  identityFile: string;
  knownHostsFile: string;
}
interface FileEntry { data: string; executable: boolean }
type Snapshot = Record<string, FileEntry>;
export interface SandboxResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  errorCode?: string;
  files: Snapshot;
  deleted: string[];
}
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FILES = 10_000;

function envLimit(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function sandboxSyncLimits() {
  return {
    maxFileBytes: envLimit("CCA_SANDBOX_MAX_FILE_BYTES", DEFAULT_MAX_FILE_BYTES),
    maxBytes: envLimit("CCA_SANDBOX_MAX_BYTES", DEFAULT_MAX_BYTES),
    maxFiles: envLimit("CCA_SANDBOX_MAX_FILES", DEFAULT_MAX_FILES),
  };
}

function formatMib(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return Number.isInteger(mib) ? String(mib) : mib.toFixed(1);
}

function syncLimitError(limits = sandboxSyncLimits()): Error {
  return new Error(`沙箱同步上限：单文件 ${formatMib(limits.maxFileBytes)} MiB、合计 ${formatMib(limits.maxBytes)} MiB、${limits.maxFiles} 个文件；请缩小工作区`);
}

export function isSnapshotSkipped(name: string, directory = false): boolean {
  return isSandboxPathIgnored(name, directory);
}

export function isPreviousExportFailed(error: unknown): boolean {
  return error instanceof Error && /Previous workspace export failed|recover remote files/i.test(error.message);
}

/** Workspace-relative git paths, or undefined when this is not a git work tree. */
export function gitSnapshotNames(root: string): string[] | undefined {
  const toplevel = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (toplevel.status !== 0) return undefined;
  const gitRoot = path.resolve(toplevel.stdout.trim());
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(gitRoot, resolvedRoot).split(path.sep).join("/");
  if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const spec = relative || ".";
  const listed = spawnSync("git", ["-C", gitRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", spec], {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (listed.status !== 0) return undefined;
  const prefix = relative ? relative + "/" : "";
  return listed.stdout.toString("utf8").split("\0").filter(Boolean).flatMap((name) => {
    const posix = name.replaceAll("\\", "/");
    if (!prefix) return [posix];
    return posix.startsWith(prefix) ? [posix.slice(prefix.length)] : [];
  }).filter((name) => name && !name.endsWith("/") && !isSnapshotSkipped(name));
}

export const SANDBOX_INSTRUCTIONS = `本会话使用远端 Docker 工作区 /workspace。所有代码、命令和项目文件操作必须使用 cca_sandbox 的 run_code 工具。
run_code 接收 JavaScript async 函数体，可在同一代码块内使用 for/while、条件和 Promise.all 调用 tools.exec(command, {cwd?, timeout_ms?})、tools.read_file(path)、tools.write_file(path, content)、tools.list_files(path?)、tools.fetch(url, {timeout_ms?})。
用 print(value) 输出需要反馈给模型的结果，或 return JSON 值；不要每次循环都请求模型。示例：for (const file of await tools.list_files('.')) { print(file); }
每次执行使用独立 Linux Docker 容器和全新工作目录，源码及普通文件自动同步回工作区；依赖、构建缓存、JS 内存、/tmp 和后台进程均不跨代码块保留。安装依赖、构建和测试必须放在同一个 run_code 中完成，先检查 tools.exec 的 exitCode 再执行后续步骤。
工作区可能包含多层嵌套或多个工程，先定位 package.json、pyproject.toml/requirements.txt、go.mod/go.work、pom.xml/build.gradle(.kts) 等清单，再用 tools.exec 的 cwd 指定实际工程目录。会话/宿主工作区路径会自动映射到 /workspace；目录不存在时返回 errorCode=ENOENT 和 "directory does not exist"，子命令超时返回 timedOut=true 且 errorCode=TIMEOUT。
所有层级的 node_modules、Python 虚拟环境/字节码、Go 模块/编译缓存、Maven/Gradle 构建目录、.codex-tmp / .acl-recovery 等临时目录及通用 dist/build/coverage 等生成物均不参与同步。Git 仓库还会遵循 .gitignore，超过单文件上限的大文件会被跳过而不是让整个工作区失败。导出失败后可继续执行清理或后续代码块，已修改源码会先收回再继续。保留源码、清单、锁文件、Yarn/Maven/Gradle wrapper 和 Go vendor 源码。需要交付的构建产物请在同一代码块内复制到未排除的目录。Git 元数据不在沙箱中，认证 Git 操作使用平台入口。禁止尝试回退到服务端本地命令执行。`;

export async function readDockerSandboxConfig(): Promise<DockerSandboxConfig | undefined> {
  const file = process.env.CCA_DOCKER_SANDBOX_CONFIG || path.join(DATA_DIR, "docker-sandbox.json");
  let raw: string;
  try { raw = await fs.readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !process.env.CCA_DOCKER_SANDBOX_CONFIG) return;
    throw new Error("无法读取 Docker 沙箱配置", { cause: error });
  }
  const config = JSON.parse(raw) as DockerSandboxConfig;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(config.host ?? "") || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(config.username ?? "") ||
      !Number.isInteger(config.port ?? 22) || (config.port ?? 22) < 1 || (config.port ?? 22) > 65535 ||
      !path.isAbsolute(config.identityFile ?? "") || !path.isAbsolute(config.knownHostsFile ?? "")) {
    throw new Error("Docker 沙箱 SSH 配置无效");
  }
  await Promise.all([fs.access(config.identityFile), fs.access(config.knownHostsFile)]);
  return config;
}

export function validateWorkspaceName(name: string): string[] {
  const parts = name.split("/");
  if (!name || name.includes("\\") || isSandboxPathIgnored(name) || parts.some(p => !p || p === "." || p === ".." ||
      /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) {
    throw new Error("沙箱返回了无效的工作区路径");
  }
  return parts;
}

async function safeLocalPath(root: string, name: string): Promise<string> {
  let current = root;
  for (const part of validateWorkspaceName(name)) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw new Error("沙箱同步不能经过符号链接"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}

async function addSnapshotFile(
  files: Snapshot,
  root: string,
  name: string,
  state: { total: number; count: number; limits: ReturnType<typeof sandboxSyncLimits> },
): Promise<void> {
  if (!name || name.includes("\\") || isSnapshotSkipped(name) || name.split("/").some((part) => !part || part === "." || part === "..")) return;
  const file = path.join(root, ...name.split("/"));
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  if (stat.isSymbolicLink() || !stat.isFile()) return;
  if (stat.size > state.limits.maxFileBytes) return;
  if (state.total + stat.size > state.limits.maxBytes || state.count >= state.limits.maxFiles) throw syncLimitError(state.limits);
  const data = await fs.readFile(file);
  if (data.length !== stat.size) throw new Error("同步期间文件发生变化，请重试");
  files[name] = { data: data.toString("base64"), executable: process.platform !== "win32" && Boolean(stat.mode & 0o111) };
  state.total += stat.size;
  state.count += 1;
}

export async function snapshotWorkspace(root: string): Promise<Snapshot> {
  const files: Snapshot = Object.create(null);
  const state = { total: 0, count: 0, limits: sandboxSyncLimits() };
  const gitNames = gitSnapshotNames(root);
  if (gitNames) {
    for (const name of gitNames) await addSnapshotFile(files, root, name, state);
    return files;
  }
  async function walk(directory: string, prefix: string) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isSymbolicLink() || isSnapshotSkipped(name, entry.isDirectory())) continue;
      if (entry.isDirectory()) { await walk(path.join(directory, entry.name), name + "/"); continue; }
      if (!entry.isFile()) continue;
      await addSnapshotFile(files, root, name, state);
    }
  }
  await walk(root, "");
  return files;
}

/** Validate the complete change set and detect concurrent editor writes before applying it. */
export async function applySandboxChanges(root: string, before: Snapshot, result: SandboxResult): Promise<void> {
  if (!result.files || typeof result.files !== "object" || !Array.isArray(result.deleted)) throw new Error("沙箱文件响应无效");
  const names = [...Object.keys(result.files), ...result.deleted];
  if (names.length > 20000 || new Set(names.map(n => process.platform === "win32" ? n.toLowerCase() : n)).size !== names.length) {
    throw new Error("沙箱文件响应包含重复路径");
  }
  const staged: { file: string; data?: Buffer; executable?: boolean }[] = [];
  const limits = sandboxSyncLimits();
  let bytes = 0;
  for (const name of names) {
    if (isSnapshotSkipped(name)) continue;
    const file = await safeLocalPath(root, name);
    let current: Buffer | undefined;
    try { current = await fs.readFile(file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (current?.toString("base64") !== before[name]?.data) throw new Error(`工作区文件已被其他操作修改，沙箱结果未覆盖：${name}`);
    const entry = result.files[name];
    if (entry && (typeof entry.data !== "string" || typeof entry.executable !== "boolean" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.data))) {
      throw new Error("沙箱文件内容无效");
    }
    const data = entry ? Buffer.from(entry.data, "base64") : undefined;
    bytes += data?.length ?? 0;
    if ((data?.length ?? 0) > limits.maxFileBytes || bytes > limits.maxBytes) throw new Error("沙箱结果超过文件同步上限");
    staged.push({ file, data, executable: entry?.executable });
  }
  for (const entry of staged) {
    if (!entry.data) { await fs.unlink(entry.file); continue; }
    await fs.mkdir(path.dirname(entry.file), { recursive: true });
    const temporary = entry.file + ".cca-" + randomBytes(8).toString("hex");
    try {
      await fs.writeFile(temporary, entry.data, { flag: "wx", mode: entry.executable ? 0o755 : 0o644 });
      await fs.rename(temporary, entry.file);
    } finally { await fs.rm(temporary, { force: true }); }
  }
}

/** Overlay recovered remote source onto the local workspace without dropping files the editor already has. */
export async function applyRecoveredWorkspace(root: string, files: Snapshot): Promise<string[]> {
  const applied: string[] = [];
  const limits = sandboxSyncLimits();
  for (const [name, entry] of Object.entries(files ?? {})) {
    if (!entry || isSnapshotSkipped(name) || typeof entry.data !== "string" || typeof entry.executable !== "boolean") continue;
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(entry.data)) continue;
    const file = await safeLocalPath(root, name);
    const data = Buffer.from(entry.data, "base64");
    if (data.length > limits.maxFileBytes) continue;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = file + ".cca-" + randomBytes(8).toString("hex");
    try {
      await fs.writeFile(temporary, data, { flag: "wx", mode: entry.executable ? 0o755 : 0o644 });
      await fs.rename(temporary, file);
      applied.push(name);
    } finally { await fs.rm(temporary, { force: true }); }
  }
  return applied;
}

export function invokeSandbox<T>(config: DockerSandboxConfig, request: object, timeoutMs = 330000): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-o", "StrictHostKeyChecking=yes",
      "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", "-o", "ForwardAgent=no",
      "-o", "ClearAllForwardings=yes", "-o", "UserKnownHostsFile=" + config.knownHostsFile,
      "-p", String(config.port ?? 22), "-i", config.identityFile, config.username + "@" + config.host],
    { stdio: "pipe", windowsHide: true });
    const chunks: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error("Docker 沙箱 SSH 请求超时"); child.kill(); }, timeoutMs);
    child.on("error", error => { failure = error; });
    child.stdin.on("error", () => { /* close reports transport failure without leaking SSH diagnostics */ });
    child.stderr.resume();
    child.stdout.on("data", (data: Buffer) => {
      size += data.length;
      if (size > sandboxSyncLimits().maxBytes * 2) { failure = new Error("Docker 沙箱响应过大"); child.kill(); }
      else chunks.push(data);
    });
    child.once("close", code => {
      clearTimeout(timer);
      if (failure) { reject(failure); return; }
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { result: T; error?: string };
        if (response.error) throw new Error("Docker 沙箱：" + response.error);
        if (code !== 0 || response.result === undefined) throw new Error("Docker 沙箱 SSH 连接失败");
        resolve(response.result);
      } catch (error) {
        reject(error instanceof SyntaxError ? new Error("Docker 沙箱连接失败，请检查 SSH 密钥、主机指纹和远端网关") : error);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export class DockerSandbox {
  private active: { id: string; done: Promise<unknown>; controller: AbortController; dispatched(): boolean } | undefined;
  private closed = false;
  readonly workspace: string;
  constructor(readonly config: DockerSandboxConfig, readonly sessionId: string, readonly cwd: string, readonly network: boolean) {
    this.workspace = createHash("sha256").update(cwd + "\0" + sessionId).digest("hex").slice(0, 32);
  }
  run(code: string, timeoutMs = 60000): Promise<Omit<SandboxResult, "files" | "deleted"> & { changedFiles: string[] }> {
    if (this.closed) return Promise.reject(new Error("Docker 沙箱已关闭"));
    if (this.active) return Promise.reject(new Error("当前会话已有代码块正在执行，请在一个代码块中使用循环或 Promise.all"));
    if (typeof code !== "string" || !code.trim() || Buffer.byteLength(code) > 256 * 1024 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) {
      return Promise.reject(new Error("代码块不能为空且不能超过 256 KiB，超时需为 100 至 300000 毫秒"));
    }
    const id = randomBytes(16).toString("hex");
    const controller = new AbortController();
    let dispatched = false;
    const done = (async () => {
      let before = await snapshotWorkspace(this.cwd);
      // abort() may arrive while the local snapshot is still being collected.
      if (this.closed) throw new Error("Docker 沙箱已关闭");
      controller.signal.throwIfAborted();
      dispatched = true;
      const request = {
        action: "run", workspace_policy_version: SANDBOX_WORKSPACE_POLICY_VERSION, workspace: this.workspace, run: id,
        code, timeout_ms: timeoutMs, files: before, network: this.network, host_workspace: this.cwd,
      };
      let result: SandboxResult;
      try {
        result = await invokeSandbox<SandboxResult>(this.config, request);
      } catch (error) {
        if (!isPreviousExportFailed(error)) throw error;
        const recovered = await invokeSandbox<{ files?: Snapshot }>(this.config, {
          action: "recover", workspace_policy_version: SANDBOX_WORKSPACE_POLICY_VERSION, workspace: this.workspace,
        }, 45000);
        await applyRecoveredWorkspace(this.cwd, recovered.files ?? {});
        before = await snapshotWorkspace(this.cwd);
        if (this.closed) throw new Error("Docker 沙箱已关闭");
        controller.signal.throwIfAborted();
        result = await invokeSandbox<SandboxResult>(this.config, { ...request, files: before });
      }
      try { await applySandboxChanges(this.cwd, before, result); }
      catch (error) {
        const recovery = path.join(DATA_DIR, "sandbox-recovery", id + ".json");
        await fs.mkdir(path.dirname(recovery), { recursive: true, mode: 0o700 });
        await fs.writeFile(recovery, JSON.stringify(result), { mode: 0o600 });
        throw new Error(`${error instanceof Error ? error.message : "沙箱同步失败"}；结果已保存在服务端 ${recovery}`);
      }
      const { files, deleted, ...output } = result;
      return {
        ...output,
        timedOut: output.timedOut,
        errorCode: output.timedOut ? output.errorCode || "TIMEOUT" : output.errorCode,
        changedFiles: [...Object.keys(files), ...deleted],
      };
    })();
    this.active = { id, done, controller, dispatched: () => dispatched };
    void done.finally(() => { if (this.active?.id === id) this.active = undefined; }).catch(() => {});
    return done;
  }
  async abort(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.controller.abort();
    if (active.dispatched()) await invokeSandbox(this.config, { action: "cancel", run: active.id }, 45000);
    await active.done.catch(() => {});
  }
  async close(): Promise<void> { this.closed = true; await this.abort(); }
}

export async function startDockerSandboxServer(sessionId: string, cwd: string, network: boolean) {
  const config = await readDockerSandboxConfig();
  if (!config) return;
  // A configured remote sandbox must fail closed; never silently execute locally.
  const health = await invokeSandbox<{ workspacePolicyVersion?: number }>(config, { action: "health" }, 45000);
  if (health.workspacePolicyVersion !== SANDBOX_WORKSPACE_POLICY_VERSION) {
    throw new Error("远端 Docker 沙箱网关版本不匹配，请同步更新 gateway.py 和 dockerSandboxPolicy.json 后重新打开会话");
  }
  const sandbox = new DockerSandbox(config, sessionId, cwd, network);
  const token = randomBytes(32).toString("hex");
  let activeRequest: unknown;
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.authorization !== "Bearer " + token) { res.writeHead(401).end(); return; }
      if (req.url !== "/mcp" || req.method !== "POST") { res.writeHead(405).end(); return; }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 512 * 1024) { res.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.id === undefined) {
        if (request.method === "notifications/cancelled" && request.params?.requestId === activeRequest) await sandbox.abort();
        res.writeHead(202).end(); return;
      }
      const reply = (result: object) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
      if (request.method === "initialize") {
        const requested = request.params?.protocolVersion;
        reply({ protocolVersion: ["2025-11-25", "2025-06-18", "2025-03-26"].includes(requested) ? requested : "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "cca-docker-sandbox", version: "1.0.0" } });
      } else if (request.method === "ping") reply({});
      else if (request.method === "tools/list") reply({ tools: [{
        name: "run_code", description: SANDBOX_INSTRUCTIONS,
        inputSchema: { type: "object", properties: { code: { type: "string", description: "JavaScript async 函数体，支持循环、await、tools 和 print" }, timeout_ms: { type: "integer", minimum: 100, maximum: 300000, default: 60000 } }, required: ["code"], additionalProperties: false },
      }] });
      else if (request.method === "tools/call") {
        if (request.params?.name !== "run_code") throw new Error("未知沙箱工具");
        if (activeRequest !== undefined) { reply({ isError: true, content: [{ type: "text", text: "已有代码块正在执行" }] }); return; }
        activeRequest = request.id;
        const disconnected = () => { if (!res.writableEnded) void sandbox.abort().catch(() => {}); };
        res.once("close", disconnected);
        try {
          const result = await sandbox.run(request.params.arguments?.code, request.params.arguments?.timeout_ms);
          reply({ isError: result.exitCode !== 0 || result.timedOut || result.truncated, content: [{ type: "text", text: JSON.stringify(result) }] });
        } catch (error) {
          reply({ isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "沙箱执行失败" }] });
        } finally { activeRequest = undefined; res.off("close", disconnected); }
      } else {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Method not found" } }));
      }
    })().catch(() => { if (res.headersSent) res.destroy(); else res.writeHead(400).end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("沙箱工具服务启动失败");
  return { url: `http://127.0.0.1:${address.port}/mcp`, token, abort: () => sandbox.abort(), close: async () => {
    try { await sandbox.close(); }
    finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  } };
}
