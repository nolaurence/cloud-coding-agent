import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { waitForNavigationAfter } from "./navigationWait.js";

class FakeContents extends EventEmitter {
  loading = false;
  isLoadingMainFrame() { return this.loading; }
}

test("returns quickly when an optional-navigation action does not navigate", async () => {
  const contents = new FakeContents(); const started = Date.now();
  await waitForNavigationAfter(contents, () => undefined, { startGraceMs: 10, settleTimeoutMs: 100 });
  assert.ok(Date.now() - started < 80);
});

test("waits for a navigation started by an action", async () => {
  const contents = new FakeContents(); let settled = false;
  const pending = waitForNavigationAfter(contents, () => {
    contents.loading = true; contents.emit("did-start-navigation", {}, "https://example.com", false, true);
    setTimeout(() => { settled = true; contents.loading = false; contents.emit("did-stop-loading"); }, 15);
  }, { startGraceMs: 10, settleTimeoutMs: 100 });
  await pending; assert.equal(settled, true);
});

test("required navigation is bounded when it never starts", async () => {
  await assert.rejects(waitForNavigationAfter(new FakeContents(), () => undefined, { requireNavigation: true, settleTimeoutMs: 15 }), /did not start/);
});
