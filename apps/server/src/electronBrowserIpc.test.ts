import assert from "node:assert/strict";
import test from "node:test";
import { BROWSER_IPC_CHANNEL, isBrowserIpcRequest, isBrowserIpcResponse, isBrowserUseArgs } from "./electronBrowserIpc.js";

test("validates browser IPC operations without accepting executable payloads", () => {
  assert.equal(isBrowserUseArgs({ action: "type", ref: "e1", text: "hello" }), true);
  assert.equal(isBrowserUseArgs({ action: "evaluate", text: "alert(1)" }), false);
  assert.equal(isBrowserUseArgs({ action: "click", selector: 42 }), false);
  assert.equal(isBrowserIpcRequest({ channel: BROWSER_IPC_CHANNEL, kind: "request", requestId: "r1", threadId: "t1", payload: { operation: "run", args: { action: "inspect" } } }), true);
  assert.equal(isBrowserIpcRequest({ channel: BROWSER_IPC_CHANNEL, kind: "request", requestId: "r1", threadId: "t1", payload: { operation: "run", args: { action: "eval" } } }), false);
});

test("validates browser IPC responses", () => {
  assert.equal(isBrowserIpcResponse({ channel: BROWSER_IPC_CHANNEL, kind: "response", requestId: "r1", ok: true, result: null }), true);
  assert.equal(isBrowserIpcResponse({ channel: BROWSER_IPC_CHANNEL, kind: "response", requestId: "r1", ok: "yes" }), false);
  assert.equal(isBrowserIpcResponse({ channel: BROWSER_IPC_CHANNEL, kind: "response", requestId: "r1", ok: true, result: { url: 42 } }), false);
});
