import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DATA_DIR, WORKSPACE_ROOT } from "./env.js";
import { startLlmGateway, type GatewayProvider } from "./llmGateway.js";
import {
  apiKeyEnvName,
  buildDshIntegration,
  ensureDshProfile,
  ensureDshWorkspace,
  isUsableDshProvider,
  providerRouteName,
  writeDshOverlay,
  writeDshSshConfig,
  type DshGatewayRoute,
  type DshSandboxConfig,
} from "./dshProfile.js";
import { store } from "./store.js";

export interface DshStatus {
  enabled: boolean;
  ready: boolean;
  starting: boolean;
  error?: string;
  pid?: number;
  providerCount: number;
  modelCount: number;
  defaultModel?: { provider: string; model: string };
  sandboxHost?: string;
}

interface ResolvedDshConfig {
  enabled: boolean;
  bin: string;
  homeDir: string;
  templateDir: string;
  publicRoot: string;
  trustedHost: string;
  sandbox: DshSandboxConfig;
}

interface RunningGateways {
  routes: DshGatewayRoute[];
  env: Record<string, string>;
  close(): Promise<void>;
}

const READY_TIMEOUT_MS = 120_000;
const STARTUP_LINE_LIMIT = 80;
const WORKSPACE_SYNC_TIMEOUT_MS = 60 * 60_000;
const execFileAsync = promisify(execFile);

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function publicRootFromEnv(): string {
  const configured = process.env.CCA_PUBLIC_URL?.trim() || process.env.DSH_PUBLIC_URL?.trim();
  const root = configured || `http://127.0.0.1:${process.env.PORT ?? 8787}`;
  return root.replace(/\/+$/, "") + "/dsh/";
}

function resolveConfig(): ResolvedDshConfig {
  const homeDir = path.resolve(
    process.env.DSH_HOME?.trim() || path.join(DATA_DIR, "dsh-home-cca"),
  );
  const templateDir = path.resolve(
    process.env.DSH_PROFILE_TEMPLATE?.trim() || "/opt/cca-dsh/profile-template",
  );
  const sandboxEnabled = envFlag(process.env.DSH_SANDBOX_ENABLED, true);
  const helper =
    process.env.DSH_SSH_HELPER?.trim() ||
    "/opt/cca-dsh/helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js";
  const helperLocal = process.env.DSH_SSH_HELPER_LOCAL?.trim() || helper;
  const configuredHash = process.env.DSH_SSH_HELPER_HASH?.trim();
  if (sandboxEnabled && !configuredHash && !fs.existsSync(helperLocal)) {
    throw new Error(`找不到 SSH helper 安装文件: ${helperLocal}`);
  }
  const helperHash =
    configuredHash ||
    (sandboxEnabled ? sha256File(helperLocal) : "0".repeat(64));
  if (!/^[0-9a-f]{64}$/.test(helperHash)) {
    throw new Error("DSH_SSH_HELPER_HASH 必须是 64 位小写 SHA-256");
  }

  const publicRoot = publicRootFromEnv();
  let publicUrl: URL;
  try {
    publicUrl = new URL(publicRoot);
  } catch {
    throw new Error(`CCA_PUBLIC_URL 格式无效: ${publicRoot}`);
  }
  if (publicUrl.protocol !== "http:" && publicUrl.protocol !== "https:") {
    throw new Error("CCA_PUBLIC_URL 仅支持 HTTP 或 HTTPS");
  }

  return {
    enabled: envFlag(process.env.DSH_ENABLED, true),
    bin: process.env.DSH_BIN?.trim() || "dsh",
    homeDir,
    templateDir,
    publicRoot,
    trustedHost: publicUrl.host,
    sandbox: {
      enabled: sandboxEnabled,
      host: process.env.DSH_SANDBOX_SSH_HOST?.trim() || "192.168.100.130",
      user: process.env.DSH_SANDBOX_SSH_USER?.trim() || "nolaurence",
      identityFile: path.resolve(
        process.env.DSH_SANDBOX_SSH_KEY?.trim() ||
          path.join(homeDir, ".ssh", "cca_sandbox_ed25519"),
      ),
      knownHostsFile: path.resolve(
        process.env.DSH_SANDBOX_SSH_KNOWN_HOSTS?.trim() ||
          path.join(homeDir, ".ssh", "known_hosts"),
      ),
      helper,
      helperHash,
      workspace: process.env.DSH_SANDBOX_WORKSPACE?.trim() || "/workspace",
      tmpdir: process.env.DSH_SSH_TMPDIR?.trim() || "/tmp/cca-dsh-ssh",
      syncEnabled: envFlag(process.env.DSH_SANDBOX_SYNC_ENABLED, true),
      syncIdentityFile: path.resolve(
        process.env.DSH_SANDBOX_SYNC_KEY?.trim() ||
          path.join(homeDir, ".ssh", "cca_workspace_sync_ed25519"),
      ),
      hostWorkspace:
        process.env.DSH_SANDBOX_HOST_WORKSPACE?.trim() ||
        "/home/nolaurence/cca-workspaces/default",
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("无法分配 DSH 本地端口"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function redactLine(line: string): string {
  return line.replace(/([?&]token=)[^&\s]+/g, "$1***");
}

async function waitForFileOrKeyscan(file: string, host: string): Promise<void> {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const encoded = process.env.DSH_SANDBOX_KNOWN_HOSTS_BASE64?.trim();
  if (encoded) {
    fs.writeFileSync(file, Buffer.from(encoded, "base64"), { mode: 0o600 });
    return;
  }
  const output = execFileSync("ssh-keyscan", ["-H", host], {
    encoding: "utf8",
    timeout: 15_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (!output.trim()) throw new Error(`无法获取 ${host} 的 SSH 主机密钥`);
  fs.writeFileSync(file, output, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export class DshManager {
  private config: ResolvedDshConfig | undefined;
  private child: ChildProcess | undefined;
  private childExit: Promise<void> | undefined;
  private gateways: RunningGateways | undefined;
  private supervisor: Promise<void> | undefined;
  private stopping = false;
  private reloadRequested = false;
  private launchTokenValue: string | undefined;
  private portValue: number | undefined;
  private statusValue: DshStatus = {
    enabled: true,
    ready: false,
    starting: false,
    providerCount: 0,
    modelCount: 0,
  };

  status(): DshStatus {
    return { ...this.statusValue };
  }

  get upstreamPort(): number | undefined {
    return this.portValue;
  }

  get launchToken(): string | undefined {
    return this.launchTokenValue;
  }

  start(): void {
    if (this.supervisor) return;
    try {
      this.config = resolveConfig();
      this.statusValue.enabled = this.config.enabled;
    } catch (error) {
      this.statusValue = {
        ...this.statusValue,
        enabled: envFlag(process.env.DSH_ENABLED, true),
        starting: false,
        ready: false,
        error: error instanceof Error ? error.message : String(error),
      };
      if (!this.statusValue.enabled) return;
    }
    if (!this.statusValue.enabled) {
      this.statusValue.ready = false;
      return;
    }
    this.supervisor = this.supervise();
  }

  reload(): void {
    if (this.stopping) return;
    this.reloadRequested = true;
    this.child?.kill("SIGTERM");
  }

  async waitUntilReady(timeoutMs = 30_000): Promise<void> {
    if (this.statusValue.ready) return;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.statusValue.ready) return;
      if (this.statusValue.error && !this.statusValue.starting) {
        throw new Error(this.statusValue.error);
      }
      await delay(100);
    }
    throw new Error(this.statusValue.error || "DeepSeek Harness 启动超时");
  }

  async close(): Promise<void> {
    this.stopping = true;
    this.reloadRequested = false;
    this.statusValue = { ...this.statusValue, ready: false, starting: false };
    await this.stopChild();
    await this.gateways?.close().catch(() => undefined);
    this.gateways = undefined;
    await this.supervisor?.catch(() => undefined);
    this.supervisor = undefined;
  }

  private async supervise(): Promise<void> {
    let failures = 0;
    while (!this.stopping) {
      this.reloadRequested = false;
      this.statusValue = {
        ...this.statusValue,
        ready: false,
        starting: true,
        error: undefined,
      };
      try {
        await this.launch();
        failures = 0;
        this.statusValue = { ...this.statusValue, ready: true, starting: false };
        await this.childExit;
        if (this.stopping) break;
        this.statusValue = {
          ...this.statusValue,
          ready: false,
          error: this.reloadRequested ? undefined : "DeepSeek Harness 已退出，正在重启",
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.statusValue = {
          ...this.statusValue,
          ready: false,
          starting: false,
          error: message,
        };
        console.error("[cca] DeepSeek Harness 启动失败:", message);
      } finally {
        await this.stopChild();
        await this.gateways?.close().catch(() => undefined);
        this.gateways = undefined;
      }

      if (this.stopping) break;
      failures += 1;
      if (this.reloadRequested) failures = 0;
      const waitMs = failures === 0 ? 250 : Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5));
      await delay(waitMs);
    }
    this.statusValue = { ...this.statusValue, ready: false, starting: false };
  }

  private async launch(): Promise<void> {
    const config = this.config;
    if (!config) throw new Error("DeepSeek Harness 配置尚未初始化");
    let sshBinDir: string | undefined;
    if (config.sandbox.enabled) {
      if (!fs.existsSync(config.sandbox.identityFile)) {
        throw new Error(`缺少沙箱 SSH 私钥: ${config.sandbox.identityFile}`);
      }
      fs.chmodSync(config.sandbox.identityFile, 0o600);
      await waitForFileOrKeyscan(config.sandbox.knownHostsFile, config.sandbox.host);
      sshBinDir = writeDshSshConfig(config.homeDir, config.sandbox);
      await this.syncWorkspace(sshBinDir);
    }

    ensureDshProfile(config.homeDir, config.templateDir);
    ensureDshWorkspace(config.homeDir, config.sandbox.workspace, store.projects);
    const gateways = await this.startGateways();
    this.gateways = gateways;
    const integration = buildDshIntegration(store.settings, gateways.routes, config.sandbox);
    this.statusValue = {
      ...this.statusValue,
      providerCount: gateways.routes.length,
      modelCount: gateways.routes.reduce((total, route) => total + route.provider.models.length, 0),
      defaultModel: integration.defaultModel,
      sandboxHost: config.sandbox.enabled ? config.sandbox.host : undefined,
    };

    const overlayPath = path.join(config.homeDir, "cca-integration.json");
    writeDshOverlay(overlayPath, integration.patch);
    const port = await allocateLoopbackPort();
    this.portValue = port;
    this.launchTokenValue = undefined;

    const child = spawn(
      config.bin,
      [
        "--profile",
        "web",
        "--patch",
        overlayPath,
        "--no-open",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--public-url",
        config.publicRoot,
        "--trusted-host",
        config.trustedHost,
      ],
      {
        cwd: config.homeDir,
        env: {
          ...process.env,
          HOME: config.homeDir,
          DSH_HOME: config.homeDir,
          DSH_TELEMETRY_DISABLED: "1",
          DSH_PERMISSION_MODE: "danger-full-access",
          ...(sshBinDir
            ? { PATH: `${sshBinDir}:${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}` }
            : {}),
          ...gateways.env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child = child;
    if (child.pid) this.statusValue = { ...this.statusValue, pid: child.pid };
    this.childExit = new Promise((resolve) => {
      child.once("close", () => resolve());
    });

    let settled = false;
    let output: string[] = [];
    let readyResolve: () => void;
    let readyReject: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      readyReject(
        new Error(
          `DeepSeek Harness 启动超时: ${output.slice(-STARTUP_LINE_LIMIT).join("\n")}`,
        ),
      );
    }, READY_TIMEOUT_MS);
    timer.unref();

    const consume = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        if (process.env.DSH_DEBUG === "1") console.error("[dsh]", redactLine(line));
        output.push(redactLine(line));
        if (output.length > STARTUP_LINE_LIMIT) output = output.slice(-STARTUP_LINE_LIMIT);
        const match = line.match(/dsh web:\s+(https?:\/\/\S+)/);
        if (match && !settled) {
          try {
            const url = new URL(match[1]!);
            const token = url.searchParams.get("token");
            if (!token) throw new Error("启动 URL 缺少 launch token");
            this.launchTokenValue = token;
            settled = true;
            clearTimeout(timer);
            readyResolve();
          } catch (error) {
            settled = true;
            clearTimeout(timer);
            readyReject(error instanceof Error ? error : new Error(String(error)));
          }
        } else if (
          !settled &&
          /(error|Error|failed|Failed|EADDRINUSE|Cannot find|ERR_)/.test(line)
        ) {
          output.push(redactLine(line));
        }
      }
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      readyReject(error);
    });
    child.once("close", (code, signal) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        readyReject(
          new Error(
            `DeepSeek Harness 在就绪前退出 (${signal ?? code}): ${output
              .slice(-STARTUP_LINE_LIMIT)
              .join("\n")}`,
          ),
        );
      }
    });

    try {
      await ready;
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    }
  }

  private async syncWorkspace(sshBinDir: string): Promise<void> {
    const config = this.config;
    if (!config?.sandbox.syncEnabled) return;
    const marker = path.join(config.homeDir, ".workspace-sync-v1.json");
    if (fs.existsSync(marker)) return;
    const key = config.sandbox.syncIdentityFile;
    if (!key || !fs.existsSync(key)) {
      console.warn("[cca] 未安装工作区同步密钥，跳过 241 -> 130 文件同步");
      return;
    }
    if (!fs.existsSync(WORKSPACE_ROOT)) {
      console.warn(`[cca] 工作区目录不存在，跳过同步: ${WORKSPACE_ROOT}`);
      return;
    }
    fs.chmodSync(key, 0o600);
    const ssh = path.join(sshBinDir, "rsync-ssh");
    console.log(
      `[cca] 正在同步工作区 ${WORKSPACE_ROOT} -> ${config.sandbox.host}:${config.sandbox.hostWorkspace}`,
    );
    try {
      await execFileAsync(
        "rsync",
        [
          "-a",
          "--ignore-existing",
          "--exclude=/lost+found",
          "-e",
          ssh,
          `${path.resolve(WORKSPACE_ROOT)}/`,
          "cca-workspace-sync:./",
        ],
        { timeout: WORKSPACE_SYNC_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      );
      const temporary = `${marker}.${process.pid}.tmp`;
      fs.writeFileSync(
        temporary,
        `${JSON.stringify(
          {
            source: path.resolve(WORKSPACE_ROOT),
            destination: config.sandbox.hostWorkspace,
            completedAt: new Date().toISOString(),
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      fs.renameSync(temporary, marker);
      console.log("[cca] 工作区文件同步完成");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[cca] 工作区同步失败，DSH 将继续启动并在下次重试: ${message}`);
    }
  }

  private async startGateways(): Promise<RunningGateways> {
    const routes: DshGatewayRoute[] = [];
    const env: Record<string, string> = {};
    const closers: Array<() => Promise<void>> = [];
    try {
      const providers = store.settings.providers.filter(isUsableDshProvider);
      for (const [index, provider] of providers.entries()) {
        const gatewayProvider: GatewayProvider = {
          type: provider.type,
          baseUrl: provider.baseUrl,
          apiKey: provider.apiKey,
          wireApi: provider.wireApi,
          azure: provider.azureApiVersion
            ? { apiVersion: provider.azureApiVersion }
            : undefined,
        };
        const gateway = await startLlmGateway(gatewayProvider);
        closers.push(gateway.close);
        const apiKeyEnv = apiKeyEnvName(index);
        env[apiKeyEnv] = gateway.token;
        routes.push({
          provider,
          providerName: providerRouteName(provider.id, index),
          apiKeyEnv,
          url: gateway.url,
        });
      }
      if (routes.length === 0) {
        throw new Error("没有可用于 DSH 的 OpenAI 兼容模型提供方");
      }
      return {
        routes,
        env,
        async close() {
          await Promise.allSettled(closers.map((close) => close()));
        },
      };
    } catch (error) {
      await Promise.allSettled(closers.map((close) => close()));
      throw error;
    }
  }

  private async stopChild(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.childExit = undefined;
    this.portValue = undefined;
    this.launchTokenValue = undefined;
    delete this.statusValue.pid;
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    await Promise.race([closed, delay(5_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

export const dshManager = new DshManager();
