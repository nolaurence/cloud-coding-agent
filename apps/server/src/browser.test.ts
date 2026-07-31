import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright-core";
import { BrowserPool, assertSafeBrowserUrl, createBrowserUseTool, type BrowserManager } from "./browser.js";

function toolWithPage(page: Partial<Page>) {
  const manager = {
    run: async <T>(operation: (activePage: Page) => Promise<T>) => operation(page as Page),
  } as unknown as BrowserManager;
  return createBrowserUseTool(manager) as unknown as {
    handler: (args: Record<string, unknown>) => Promise<unknown>;
  };
}

test("browser navigate requires a URL", async () => {
  const tool = toolWithPage({});
  await assert.rejects(tool.handler({ action: "navigate" }), /需要 url/);
});

test("browser click requires an inspected ref or selector", async () => {
  const tool = toolWithPage({});
  await assert.rejects(tool.handler({ action: "click" }), /需要 ref 或 selector/);
});

test("browser press defaults to Enter", async () => {
  let pressed = "";
  const locator = (selector: string) => selector === "body"
    ? { innerText: async () => "page" }
    : { evaluateAll: async () => [] };
  const tool = toolWithPage({
    keyboard: { press: async (key: string) => { pressed = key; } } as Page["keyboard"],
    locator: locator as unknown as Page["locator"],
    url: () => "about:blank",
    title: async () => "Blank",
  });
  await tool.handler({ action: "press" });
  assert.equal(pressed, "Enter");
});

test("browser pool isolates managers by thread and consumes VNC tickets once", () => {
  const pool = new BrowserPool();
  assert.notEqual(pool.forThread("thread-a"), pool.forThread("thread-b"));
  assert.equal(pool.forThread("thread-a"), pool.forThread("thread-a"));

  const ticket = pool.issueTicket("thread-a", "alice");
  const consumed = pool.consumeTicket(ticket);
  assert.equal(consumed?.threadId, "thread-a");
  assert.equal(consumed?.username, "alice");
  assert.equal(typeof consumed?.expiresAt, "number");
  assert.equal(pool.consumeTicket(ticket), null);
});

test("browser pool rejects expired VNC tickets", () => {
  const pool = new BrowserPool();
  const now = Date.now;
  try {
    Date.now = () => 1_000;
    const ticket = pool.issueTicket("thread-a", "alice");
    Date.now = () => 62_000;
    assert.equal(pool.consumeTicket(ticket), null);
  } finally {
    Date.now = now;
  }
});

test("browser navigation blocks IPv4-mapped IPv6 loopback", async () => {
  await assert.rejects(assertSafeBrowserUrl("http://[::ffff:127.0.0.1]:8787"), /禁止访问/);
});

test("browser navigation blocks loopback and URL credentials", async () => {
  await assert.rejects(assertSafeBrowserUrl("http://127.0.0.1:8787"), /禁止访问/);
  await assert.rejects(assertSafeBrowserUrl("https://user:pass@example.com"), /不含凭据/);
});
