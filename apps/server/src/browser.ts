import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import { lookup } from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { defineTool, type Tool } from "@github/copilot-sdk";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { DATA_DIR } from "./env.js";
import { BROWSER_IPC_CHANNEL, BROWSER_IPC_TIMEOUT_MS, isBrowserIpcResponse, type BrowserInspectResult, type BrowserIpcOperation, type BrowserIpcRequest } from "./electronBrowserIpc.js";

const SCREEN = process.env.BROWSER_SCREEN?.trim() || "1280x900x24";
const START_TIMEOUT_MS = 20_000;
const VNC_TICKET_TTL_MS = 60_000;
const ALLOW_PRIVATE_NETWORK = process.env.BROWSER_ALLOW_PRIVATE_NETWORK === "true";
export const NOVNC_ROOT = process.env.NOVNC_ROOT?.trim() || "/usr/share/novnc";

export type BrowserAction = "navigate" | "inspect" | "click" | "type" | "press" | "scroll" | "back" | "forward" | "reload";

export interface BrowserUseArgs {
  action: BrowserAction;
  url?: string;
  ref?: string;
  selector?: string;
  text?: string;
  key?: string;
  direction?: "up" | "down";
}

export interface BrowserStatus {
  enabled: boolean;
  ready: boolean;
  starting: boolean;
  error?: string;
}

interface VncTicket {
  threadId: string;
  username: string;
  expiresAt: number;
}

function executable(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (candidate.includes("/") && fs.existsSync(candidate)) return candidate;
    const found = process.env.PATH?.split(path.delimiter)
      .map((directory) => path.join(directory, candidate))
      .find((file) => fs.existsSync(file));
    if (found) return found;
  }
  return null;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("无法分配浏览器端口")));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForUrl(url: string) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`浏览器启动超时: ${lastError instanceof Error ? lastError.message : url}`);
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b! >= 64 && b! <= 127) || a! >= 224;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith("::ffff:")) {
      const mapped = normalized.slice("::ffff:".length);
      if (net.isIPv4(mapped)) return isPrivateAddress(mapped);
      const groups = mapped.split(":");
      if (groups.length === 2) {
        const high = Number.parseInt(groups[0]!, 16);
        const low = Number.parseInt(groups[1]!, 16);
        if (Number.isInteger(high) && Number.isInteger(low)) {
          return isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
        }
      }
      return true;
    }
    return normalized === "::1" || normalized === "::" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) || normalized.startsWith("ff");
  }
  return true;
}

export async function assertSafeBrowserUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("浏览器地址无效");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("仅支持不含凭据的 HTTP 或 HTTPS 地址");
  }
  if (ALLOW_PRIVATE_NETWORK) return url;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new Error("浏览器默认禁止访问本机、内网和元数据地址");
  }
  return url;
}

export interface BrowserController {
  readonly enabled: boolean;
  status(): BrowserStatus;
  start(): Promise<void>;
  runAction(args: BrowserUseArgs): Promise<BrowserInspectResult>;
  redeemTicket(ticket: string): Promise<void>;
  vncWebSocketPort?(): number;
  stop(): Promise<void>;
}

class ElectronIpcBrowserManager implements BrowserController {
  readonly enabled = true;
  private ready = false;
  private starting: Promise<void> | null = null;
  private error: string | undefined;
  private operation = Promise.resolve();

  constructor(private readonly threadId: string) {}

  status(): BrowserStatus {
    return { enabled: true, ready: this.ready, starting: this.starting !== null, error: this.error };
  }

  private request<T>(payload: BrowserIpcOperation): Promise<T> {
    if (!process.send || !process.connected) return Promise.reject(new Error("Electron browser IPC is unavailable"));
    const requestId = crypto.randomUUID();
    const message: BrowserIpcRequest = { channel: BROWSER_IPC_CHANNEL, kind: "request", requestId, threadId: this.threadId, payload };
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error("Electron browser operation timed out")), BROWSER_IPC_TIMEOUT_MS);
      const onDisconnect = () => finish(new Error("Electron browser IPC disconnected"));
      const onMessage = (response: unknown) => {
        if (!isBrowserIpcResponse(response) || response.requestId !== requestId) return;
        finish(response.ok ? undefined : new Error(response.error || "Electron browser operation failed"), response.result as T);
      };
      const finish = (error?: Error, result?: T) => {
        clearTimeout(timer);
        process.off("message", onMessage);
        process.off("disconnect", onDisconnect);
        error ? reject(error) : resolve(result as T);
      };
      process.on("message", onMessage);
      process.once("disconnect", onDisconnect);
      process.send!(message, (error) => { if (error) finish(error); });
    });
  }

  async start(): Promise<void> {
    if (this.ready) return;
    if (!this.starting) {
      this.starting = this.request<BrowserStatus>({ operation: "start" }).then((status) => {
        if (!status.ready) throw new Error(status.error || "Electron browser did not become ready");
        this.ready = true;
        this.error = undefined;
      }).catch((error) => {
        this.error = error instanceof Error ? error.message : String(error);
        throw error;
      }).finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  runAction(args: BrowserUseArgs): Promise<BrowserInspectResult> {
    const pending = this.operation.then(async () => {
      await this.start();
      return this.request<BrowserInspectResult>({ operation: "run", args });
    });
    this.operation = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async redeemTicket(ticket: string): Promise<void> {
    await this.start();
    await this.request({ operation: "redeem-ticket", ticket });
  }

  async stop(): Promise<void> {
    if (process.connected) await this.request({ operation: "stop" }).catch(() => undefined);
    this.ready = false;
  }
}

export class BrowserManager implements BrowserController {
  private processes = new Map<ChildProcess, string>();
  private expectedStops = new WeakSet<ChildProcess>();
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private starting: Promise<void> | null = null;
  private stopping = false;
  private error: string | undefined;
  private operation = Promise.resolve();
  private webSocketPort: number | null = null;
  readonly enabled = process.env.BROWSER_ENABLED !== "false";

  constructor(private readonly threadId: string, private readonly slot: number) {}

  status(): BrowserStatus {
    return {
      enabled: this.enabled,
      ready: this.processes.size === 4 && this.browser?.isConnected() === true && this.webSocketPort !== null,
      starting: this.starting !== null,
      error: this.error,
    };
  }

  vncWebSocketPort(): number {
    if (!this.status().ready || this.webSocketPort === null) throw new Error(this.error || "浏览器未就绪");
    return this.webSocketPort;
  }

  async start() {
    if (!this.enabled) throw new Error("浏览器功能已禁用");
    if (this.status().ready) return;
    if (!this.starting) {
      this.starting = this.startProcesses().catch(async (error) => {
        this.error = error instanceof Error ? error.message : String(error);
        await this.stopProcesses();
        throw error;
      }).finally(() => {
        this.starting = null;
      });
    }
    return this.starting;
  }

  private launch(command: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
    const name = path.basename(command);
    const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "pipe"] });
    this.processes.set(child, name);
    child.stderr?.on("data", (chunk) => {
      const message = String(chunk).trim();
      if (message) console.error(`[browser:${this.threadId}:${name}] ${message}`);
    });
    child.once("error", (error) => this.handleProcessFailure(child, `${name} 启动失败: ${error.message}`));
    child.once("exit", (code, signal) => {
      this.processes.delete(child);
      if (!this.expectedStops.has(child) && !this.stopping) {
        this.handleProcessFailure(child, `${name} 意外退出 (${signal ?? code ?? "unknown"})`);
      }
    });
  }

  private handleProcessFailure(_child: ChildProcess, message: string) {
    if (this.stopping) return;
    this.error = message;
    void this.stopProcesses();
  }

  private async startProcesses() {
    await this.stopProcesses();
    const xvfb = executable(["Xvfb"]);
    const chrome = executable([process.env.BROWSER_EXECUTABLE_PATH?.trim() || "", "chromium", "chromium-browser", "google-chrome"].filter(Boolean));
    const x11vnc = executable(["x11vnc"]);
    const websockify = executable(["websockify"]);
    const missing = [!xvfb && "Xvfb", !chrome && "Chromium", !x11vnc && "x11vnc", !websockify && "websockify"].filter(Boolean);
    if (missing.length) throw new Error(`缺少浏览器运行依赖: ${missing.join(", ")}`);

    const display = `:${100 + this.slot}`;
    const [cdpPort, vncPort, webSocketPort] = await Promise.all([freePort(), freePort(), freePort()]);
    const profileDir = path.join(DATA_DIR, "browsers", this.threadId);
    fs.mkdirSync(profileDir, { recursive: true });
    this.launch(xvfb!, [display, "-screen", "0", SCREEN, "-ac", "-nolisten", "tcp"]);
    await delay(500);
    this.launch(chrome!, [
      `--display=${display}`, `--remote-debugging-port=${cdpPort}`, "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`, "--window-size=1280,900", "--window-position=0,0", "--no-sandbox", "--disable-dev-shm-usage",
      "--disable-gpu", "--no-first-run", "--no-default-browser-check", "about:blank",
    ], { ...process.env, DISPLAY: display });
    this.launch(x11vnc!, ["-display", display, "-nopw", "-shared", "-forever", "-localhost", "-rfbport", String(vncPort)]);
    this.launch(websockify!, [`127.0.0.1:${webSocketPort}`, `127.0.0.1:${vncPort}`]);

    await waitForUrl(`http://127.0.0.1:${cdpPort}/json/version`);
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    this.context = this.browser.contexts()[0] ?? await this.browser.newContext();
    await this.context.route("**/*", async (route) => {
      const requestUrl = route.request().url();
      if (!requestUrl.startsWith("http://") && !requestUrl.startsWith("https://")) return route.continue();
      try {
        await assertSafeBrowserUrl(requestUrl);
        await route.continue();
      } catch {
        await route.abort("blockedbyclient");
      }
    });
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    this.webSocketPort = webSocketPort;
    this.error = undefined;
    console.log(`[cca] browser ready for thread ${this.threadId} on ${display}`);
  }

  async run<T>(operation: (page: Page) => Promise<T>): Promise<T> {
    const pending = this.operation.then(async () => {
      await this.start();
      if (!this.page || !this.status().ready) throw new Error(this.error || "浏览器未就绪");
      return operation(this.page);
    });
    this.operation = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private async stopProcesses() {
    this.stopping = true;
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.webSocketPort = null;
    if (browser) await browser.close().catch(() => undefined);
    for (const child of [...this.processes.keys()].reverse()) {
      this.expectedStops.add(child);
      if (child.pid && child.exitCode === null) child.kill("SIGTERM");
    }
    this.processes.clear();
    this.stopping = false;
  }

  async runAction(args: BrowserUseArgs): Promise<BrowserInspectResult> {
    return this.run((page) => runPlaywrightAction(page, args));
  }

  async redeemTicket(_ticket: string): Promise<void> {}

  async stop() {
    await this.stopProcesses();
  }
}

export class BrowserPool {
  private managers = new Map<string, BrowserController>();
  private tickets = new Map<string, VncTicket>();
  private nextSlot = 0;

  forThread(threadId: string): BrowserController {
    let manager = this.managers.get(threadId);
    if (!manager) {
      manager = process.env.BROWSER_BACKEND === "electron-ipc"
        ? new ElectronIpcBrowserManager(threadId)
        : new BrowserManager(threadId, this.nextSlot++);
      this.managers.set(threadId, manager);
    }
    return manager;
  }

  issueTicket(threadId: string, username: string): string {
    const ticket = crypto.randomUUID();
    this.tickets.set(ticket, { threadId, username, expiresAt: Date.now() + VNC_TICKET_TTL_MS });
    return ticket;
  }

  consumeTicket(ticket: string): VncTicket | null {
    const value = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return value && value.expiresAt >= Date.now() ? value : null;
  }

  async stopThread(threadId: string) {
    const manager = this.managers.get(threadId);
    this.managers.delete(threadId);
    if (manager) await manager.stop();
    for (const [ticket, value] of this.tickets) if (value.threadId === threadId) this.tickets.delete(ticket);
  }

  async stop() {
    await Promise.all([...this.managers.values()].map((manager) => manager.stop()));
    this.managers.clear();
    this.tickets.clear();
  }
}

async function inspectPage(page: Page) {
  const elements = await page.locator("a,button,input,textarea,select,[role=button],[contenteditable=true]").evaluateAll((nodes) =>
    nodes.slice(0, 150).map((node, index) => {
      const element = node as HTMLElement;
      const ref = `e${index + 1}`;
      element.dataset.ccaRef = ref;
      return { ref, tag: element.tagName.toLowerCase(), text: (element.innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").trim().slice(0, 200), type: element.getAttribute("type") || undefined };
    }),
  );
  return { url: page.url(), title: await page.title(), elements, text: (await page.locator("body").innerText()).trim().slice(0, 8_000) };
}

function targetSelector(args: BrowserUseArgs) {
  if (args.ref?.trim()) return `[data-cca-ref="${args.ref.trim().replaceAll('"', '\\"')}"]`;
  if (args.selector?.trim()) return args.selector.trim();
  throw new Error("click/type 操作需要 ref 或 selector");
}

async function runPlaywrightAction(page: Page, args: BrowserUseArgs): Promise<BrowserInspectResult> {
  switch (args.action) {
    case "navigate": {
      if (!args.url?.trim()) throw new Error("navigate 需要 url");
      const url = await assertSafeBrowserUrl(args.url.trim());
      await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      break;
    }
    case "inspect": break;
    case "click": await page.locator(targetSelector(args)).click({ timeout: 10_000 }); break;
    case "type": await page.locator(targetSelector(args)).fill(args.text ?? "", { timeout: 10_000 }); break;
    case "press": await page.keyboard.press(args.key?.trim() || "Enter"); break;
    case "scroll": await page.mouse.wheel(0, args.direction === "up" ? -700 : 700); break;
    case "back": await page.goBack({ waitUntil: "domcontentloaded" }); break;
    case "forward": await page.goForward({ waitUntil: "domcontentloaded" }); break;
    case "reload": await page.reload({ waitUntil: "domcontentloaded" }); break;
  }
  return inspectPage(page);
}

export function createBrowserUseTool(manager: BrowserController): Tool<BrowserUseArgs> {
  return defineTool<BrowserUseArgs>("browser_use", {
    description: "操作当前会话专属的可视化 Chromium 浏览器。先 inspect 获取页面内容和元素 ref,再使用 ref 点击或输入。",
    parameters: {
      type: "object", required: ["action"], properties: {
        action: { type: "string", enum: ["navigate", "inspect", "click", "type", "press", "scroll", "back", "forward", "reload"] },
        url: { type: "string", description: "navigate 的目标 URL" }, ref: { type: "string", description: "inspect 返回的元素 ref" },
        selector: { type: "string", description: "可选 CSS selector" }, text: { type: "string", description: "type 输入的文本" },
        key: { type: "string", description: "press 的按键,如 Enter、Tab、Control+A" }, direction: { type: "string", enum: ["up", "down"], description: "scroll 方向" },
      },
    } as const,
    defer: "never",
    handler: (args) => manager.runAction(args),
  });
}

export const browserPool = new BrowserPool();
