import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { isAllowedExternalUrl, serverPortFromMessage, waitForHttpReady } from "./lifecycle.js";

test("validates server readiness IPC messages", () => {
  assert.equal(serverPortFromMessage({ type: "cca-server-ready", port: 42_000 }), 42_000);
  assert.equal(serverPortFromMessage({ type: "cca-server-ready", port: 0 }), null);
  assert.equal(serverPortFromMessage({ type: "other", port: 42_000 }), null);
});

test("waits until an HTTP endpoint is ready", async () => {
  const server = createServer((_request, response) => response.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await waitForHttpReady(`http://127.0.0.1:${address.port}`, { timeoutMs: 1_000, intervalMs: 10 });
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("allows only web URLs to open externally", () => {
  assert.equal(isAllowedExternalUrl("https://github.com"), true);
  assert.equal(isAllowedExternalUrl("http://example.com"), true);
  assert.equal(isAllowedExternalUrl("file:///etc/passwd"), false);
  assert.equal(isAllowedExternalUrl("javascript:alert(1)"), false);
  assert.equal(isAllowedExternalUrl("not a url"), false);
});
