import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { isAllowedExternalUrl, LOOPBACK_HOST, serverPortFromMessage, waitForHttpReady } from "./lifecycle.js";
import { ElectronBrowserViews, isBrowserIpcRequest } from "./browserViews.js";
import { isValidBrowserBounds } from "./browserSecurity.js";
import { loadOrCreateDesktopCredentials, markDesktopCredentialsRevealed, type DesktopCredentialResult } from "./bootstrapCredentials.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(__dirname, "../../server/dist/index.js");
const PRELOAD_ENTRY = path.join(__dirname, "preload.js");
let mainWindow: BrowserWindow | null = null;
let serverProcess: ChildProcess | null = null;
let serverOrigin: string | null = null;
let quitting = false;
let stopping: Promise<void> | null = null;
let browserViews: ElectronBrowserViews | null = null;

function isMainRenderer(eventUrl: string | undefined, origin: string): boolean {
  if (!eventUrl) return false;
  try { return new URL(eventUrl).origin === origin; } catch { return false; }
}

function configureDesktopEnvironment(): DesktopCredentialResult {
  const dataDirectory = app.getPath("userData");
  const workspaceDirectory = path.join(dataDirectory, "workspaces");
  fs.mkdirSync(workspaceDirectory, { recursive: true });
  process.env.CCA_DATA_DIR = dataDirectory;
  process.env.WORKSPACE_ROOT = workspaceDirectory;
  process.env.DATABASE_URL = `sqlite:${path.join(dataDirectory, "cca.db")}`;
  process.env.BROWSER_BACKEND = "electron-ipc";
  delete process.env.BROWSER_ENABLED;
  const credentials = loadOrCreateDesktopCredentials(dataDirectory);
  process.env.ADMIN_USERNAME = credentials.username;
  process.env.ADMIN_PASSWORD = credentials.password;
  process.env.REGISTRATION_INVITE_REQUIRED = "true";
  process.env.NODE_ENV = "production";
  return credentials;
}

async function startServer(): Promise<string> {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", HOST: LOOPBACK_HOST, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  serverProcess = child;
  child.on("message", (message) => {
    if (!isBrowserIpcRequest(message)) return;
    if (!browserViews) {
      if (child.connected) child.send({ channel: "cca-browser", kind: "response", requestId: message.requestId, ok: false, error: "Electron browser window is unavailable" });
      return;
    }
    void browserViews.handle(message).then((response) => { if (child.connected) child.send(response); });
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  const exited = new Promise<never>((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => reject(new Error(`Desktop server exited before startup (${signal ?? code ?? "unknown"})`)));
  });
  const port = await Promise.race([new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for the desktop server port")), 30_000);
    child.on("message", (message) => {
      const candidate = serverPortFromMessage(message);
      if (candidate === null) return;
      clearTimeout(timer);
      resolve(candidate);
    });
  }), exited]);
  const origin = `http://${LOOPBACK_HOST}:${port}`;
  await Promise.race([waitForHttpReady(`${origin}/health`), exited]);
  serverOrigin = origin;
  return origin;
}

function createWindow(origin: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#111827",
    webPreferences: {
      preload: PRELOAD_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin === origin) return;
    } catch {
      // Invalid navigation targets are blocked below.
    }
    event.preventDefault();
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => { mainWindow = null; });
  void window.loadURL(origin);
  browserViews = new ElectronBrowserViews(window);
  ipcMain.handle("cca-browser-attach", async (event, input: unknown) => {
    if (event.sender !== window.webContents || !isMainRenderer(event.senderFrame?.url, origin)) throw new Error("Unauthorized browser view caller");
    if (!input || typeof input !== "object") throw new Error("Invalid browser view request");
    const value = input as { threadId?: unknown; ticket?: unknown; bounds?: unknown };
    if (typeof value.threadId !== "string" || typeof value.ticket !== "string" || !isValidBrowserBounds(value.bounds)) throw new Error("Invalid browser view request");
    await browserViews?.attach(value.threadId, value.ticket, value.bounds);
  });
  ipcMain.on("cca-browser-bounds", (event, input: unknown) => {
    if (event.sender !== window.webContents || !isMainRenderer(event.senderFrame?.url, origin) || !input || typeof input !== "object") return;
    const value = input as { threadId?: unknown; bounds?: unknown };
    if (typeof value.threadId === "string" && isValidBrowserBounds(value.bounds)) browserViews?.updateBounds(value.threadId, value.bounds);
  });
  ipcMain.on("cca-browser-visible", (event, input: unknown) => {
    if (event.sender !== window.webContents || !isMainRenderer(event.senderFrame?.url, origin) || !input || typeof input !== "object") return;
    const value = input as { threadId?: unknown; visible?: unknown };
    if (typeof value.threadId === "string" && typeof value.visible === "boolean") browserViews?.setVisible(value.threadId, value.visible);
  });
  ipcMain.on("cca-browser-detach", (event, threadId: unknown) => { if (event.sender === window.webContents && isMainRenderer(event.senderFrame?.url, origin) && typeof threadId === "string") browserViews?.detach(threadId); });
  return window;
}

async function stopServer(): Promise<void> {
  if (stopping) return stopping;
  const child = serverProcess;
  serverProcess = null;
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  stopping = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 5_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    if (child.connected) child.send({ type: "cca-server-shutdown" });
    else child.kill("SIGTERM");
  });
  return stopping;
}

app.on("before-quit", (event) => {
  if (quitting || !serverProcess) return;
  event.preventDefault();
  quitting = true;
  void browserViews?.destroyAll().finally(() => stopServer()).finally(() => app.quit());
});
app.on("window-all-closed", () => app.quit());
app.on("activate", () => {
  if (!mainWindow && serverOrigin) mainWindow = createWindow(serverOrigin);
});

void app.whenReady().then(async () => {
  const credentials = configureDesktopEnvironment();
  if (!fs.existsSync(SERVER_ENTRY)) throw new Error(`Missing server artifact: ${SERVER_ENTRY}`);
  const origin = await startServer();
  mainWindow = createWindow(origin);
  if (credentials.shouldReveal) {
    await dialog.showMessageBox(mainWindow, {
      type: "info", title: "Cloud Coding Agent", message: "Desktop administrator created",
      detail: `Username: ${credentials.username}\nPassword: ${credentials.password}\n\nSave this password now. It will not be shown again. Registration requires an administrator-issued invite.`,
    });
    markDesktopCredentialsRevealed(app.getPath("userData"));
  }
}).catch(async (error: unknown) => {
  console.error("[desktop] startup failed", error);
  await dialog.showMessageBox({ type: "error", title: "Cloud Coding Agent", message: "Unable to start Cloud Coding Agent", detail: error instanceof Error ? error.message : String(error) });
  await stopServer();
  app.exit(1);
});
