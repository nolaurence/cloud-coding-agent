import { BrowserWindow, session, WebContentsView, type Rectangle } from "electron";
import { isValidBrowserBounds, safeElectronBrowserUrl } from "./browserSecurity.js";
import { isBrowserIpcRequest, type BrowserInspectResult, type BrowserIpcRequest, type BrowserIpcResponse } from "../../server/src/electronBrowserIpc.js";
import type { BrowserUseArgs } from "../../server/src/browser.js";
import { waitForNavigationAfter } from "./navigationWait.js";

const SCRIPT_TIMEOUT_MS = 12_000;
const MAX_TEXT = 8_000;
const ALLOW_PRIVATE_NETWORK = process.env.BROWSER_ALLOW_PRIVATE_NETWORK === "true";

type Entry = { view: WebContentsView; ticket: string | null; attached: boolean };


const inspectScript = `(() => {
  const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role=button],[contenteditable=true]')].slice(0, 150);
  const elements = nodes.map((node, index) => {
    const ref = 'e' + (index + 1); node.dataset.ccaRef = ref;
    return { ref, tag: node.tagName.toLowerCase(), text: (node.innerText || node.getAttribute('aria-label') || node.getAttribute('placeholder') || '').trim().slice(0, 200), type: node.getAttribute('type') || undefined };
  });
  return { url: location.href, title: document.title, elements, text: (document.body?.innerText || '').trim().slice(0, ${MAX_TEXT}) };
})()`;

function selector(args: BrowserUseArgs): string {
  if (args.ref?.trim()) return `[data-cca-ref=${JSON.stringify(args.ref.trim())}]`;
  if (args.selector?.trim()) return args.selector.trim();
  throw new Error("click/type 操作需要 ref 或 selector");
}

function fixedElementScript(action: "click" | "type", target: string, text = ""): string {
  return `(() => { const el = document.querySelector(${JSON.stringify(target)}); if (!el) throw new Error('目标元素不存在'); el.scrollIntoView({block:'center'}); el.focus(); ${action === "click" ? "el.click();" : `if (!('value' in el)) throw new Error('目标不可输入'); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; setter ? setter.call(el, ${JSON.stringify(text)}) : el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true}));`} return true; })()`;
}

export class ElectronBrowserViews {
  private entries = new Map<string, Entry>();
  private operations = new Map<string, Promise<unknown>>();

  constructor(private readonly window: BrowserWindow) {}

  private async create(threadId: string): Promise<Entry> {
    const partition = `cca-browser-${threadId}-${crypto.randomUUID()}`;
    const isolatedSession = session.fromPartition(partition, { cache: false });
    isolatedSession.setPermissionCheckHandler(() => false);
    isolatedSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolatedSession.on("will-download", (event) => event.preventDefault());
    isolatedSession.webRequest.onBeforeRequest(async (details, callback) => {
      try { await safeElectronBrowserUrl(details.url); callback({}); } catch { callback({ cancel: true }); }
    });
    const view = new WebContentsView({ webPreferences: { session: isolatedSession, nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false } });
    view.setVisible(false);
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const entry = { view, ticket: null, attached: false };
    this.entries.set(threadId, entry);
    return entry;
  }

  private async entry(threadId: string): Promise<Entry> { return this.entries.get(threadId) ?? this.create(threadId); }

  private async inspect(entry: Entry): Promise<BrowserInspectResult> {
    return Promise.race([
      entry.view.webContents.executeJavaScript(inspectScript, true) as Promise<BrowserInspectResult>,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Browser inspect timed out")), SCRIPT_TIMEOUT_MS)),
    ]);
  }

  private async run(entry: Entry, args: BrowserUseArgs): Promise<BrowserInspectResult> {
    const contents = entry.view.webContents;
    switch (args.action) {
      case "navigate": { if (!args.url?.trim()) throw new Error("navigate 需要 url"); await contents.loadURL((await safeElectronBrowserUrl(args.url.trim())).href); break; }
      case "inspect": break;
      case "click": await waitForNavigationAfter(contents, () => contents.executeJavaScript(fixedElementScript("click", selector(args)), true).then(() => undefined)); break;
      case "type": await contents.executeJavaScript(fixedElementScript("type", selector(args), args.text ?? ""), true); break;
      case "press": {
        const key = args.key?.trim() || "Enter";
        const parts = key.split("+"); const actual = parts.pop()!;
        const modifiers = parts.map((part: string) => part.toLowerCase() === "control" ? "ctrl" : part.toLowerCase()) as Array<"ctrl" | "alt" | "shift" | "meta">;
        await waitForNavigationAfter(contents, () => { contents.sendInputEvent({ type: "keyDown", keyCode: actual, modifiers }); contents.sendInputEvent({ type: "keyUp", keyCode: actual, modifiers }); }); break;
      }
      case "scroll": contents.sendInputEvent({ type: "mouseWheel", x: 1, y: 1, deltaY: args.direction === "up" ? 700 : -700 }); break;
      case "back": if (contents.navigationHistory.canGoBack()) await waitForNavigationAfter(contents, () => contents.navigationHistory.goBack(), { requireNavigation: true }); break;
      case "forward": if (contents.navigationHistory.canGoForward()) await waitForNavigationAfter(contents, () => contents.navigationHistory.goForward(), { requireNavigation: true }); break;
      case "reload": await waitForNavigationAfter(contents, () => contents.reload(), { requireNavigation: true }); break;
    }
    return this.inspect(entry);
  }

  async handle(request: BrowserIpcRequest): Promise<BrowserIpcResponse> {
    try {
      const entry = await this.entry(request.threadId);
      let result: BrowserIpcResponse["result"] = null;
      if (request.payload.operation === "start") result = { enabled: true, ready: true, starting: false };
      else if (request.payload.operation === "run") {
        const pending = (this.operations.get(request.threadId) ?? Promise.resolve()).then(() => this.run(entry, request.payload.operation === "run" ? request.payload.args : { action: "inspect" }));
        this.operations.set(request.threadId, pending.catch(() => undefined)); result = await pending;
      } else if (request.payload.operation === "redeem-ticket") { entry.ticket = request.payload.ticket; result = { authorized: true }; }
      else await this.destroy(request.threadId);
      return { channel: "cca-browser", kind: "response", requestId: request.requestId, ok: true, result };
    } catch (error) { return { channel: "cca-browser", kind: "response", requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }

  async attach(threadId: string, ticket: string, bounds: Rectangle): Promise<void> {
    if (!isValidBrowserBounds(bounds)) throw new Error("Invalid browser view bounds");
    const entry = this.entries.get(threadId);
    if (!entry || !entry.ticket || entry.ticket !== ticket) throw new Error("Invalid or expired browser display ticket");
    entry.ticket = null;
    if (!entry.attached) { this.window.contentView.addChildView(entry.view); entry.attached = true; }
    entry.view.setBounds(bounds); entry.view.setVisible(true);
  }

  updateBounds(threadId: string, bounds: Rectangle): void { const entry = this.entries.get(threadId); if (entry?.attached && isValidBrowserBounds(bounds)) entry.view.setBounds(bounds); }
  setVisible(threadId: string, visible: boolean): void { const entry = this.entries.get(threadId); if (entry?.attached) entry.view.setVisible(visible); }
  detach(threadId: string): void { const entry = this.entries.get(threadId); if (entry?.attached) { entry.view.setVisible(false); this.window.contentView.removeChildView(entry.view); entry.attached = false; } }
  async destroy(threadId: string): Promise<void> { const entry = this.entries.get(threadId); if (!entry) return; this.detach(threadId); entry.view.webContents.close(); this.entries.delete(threadId); this.operations.delete(threadId); }
  async destroyAll(): Promise<void> { await Promise.all([...this.entries.keys()].map((id) => this.destroy(id))); }
}

export { isBrowserIpcRequest };
