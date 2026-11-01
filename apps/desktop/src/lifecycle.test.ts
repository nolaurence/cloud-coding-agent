import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { isAllowedExternalUrl, serverPortFromMessage, startupFailureDetail, waitForHttpReady, waitForServerReady } from "./lifecycle.js";

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

test("captures the final startup error before reporting a child exit", async () => {
  const child = spawn(process.execPath, ["-e", `
    process.stderr.write("Cannot find package '@deepseek-ai/dsh-scope'", () => process.exit(1));
  `], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let output = "";
  child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  await assert.rejects(waitForServerReady(child, 2_000), (error: Error) => {
    const detail = startupFailureDetail(error, output, "C:\\logs\\desktop-server.log");
    assert.match(detail, /退出（1）/);
    assert.match(detail, /Cannot find package '@deepseek-ai\/dsh-scope'/);
    assert.match(detail, /完整启动日志：C:\\logs\\desktop-server.log/);
    return true;
  });
  assert.equal(child.listenerCount("message"), 0);
  assert.equal(child.listenerCount("error"), 0);
  assert.equal(child.listenerCount("close"), 0);
});

test("startup succeeds only after IPC and HTTP readiness", async () => {
  const child = spawn(process.execPath, ["-e", `
    const { createServer } = require("node:http");
    const server = createServer((_request, response) => response.end("ok"));
    server.listen(0, "127.0.0.1", () => {
      process.send({ type: "cca-server-ready", port: server.address().port });
    });
  `], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  try {
    const origin = await waitForServerReady(child, 2_000);
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(child.listenerCount("message"), 0);
    assert.equal(child.listenerCount("close"), 0);
  } finally {
    child.kill();
  }
});

test("startup timeout removes listeners and keeps diagnostics bounded", async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  try {
    await assert.rejects(waitForServerReady(child, 50), /启动超时/);
    assert.equal(child.listenerCount("message"), 0);
    assert.equal(child.listenerCount("close"), 0);
    const detail = startupFailureDetail(new Error("failed"), "x".repeat(10_000) + "last error", null);
    assert.ok(detail.length < 4_100);
    assert.ok(detail.endsWith("last error"));
  } finally {
    child.kill();
  }
});

test("startup reports spawn errors without waiting for the timeout", async () => {
  const child = spawn(`${process.execPath}-missing`, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  await assert.rejects(waitForServerReady(child, 2_000), /ENOENT/);
  assert.equal(child.listenerCount("message"), 0);
});

test("a readiness IPC message does not hide an exit before HTTP readiness", async () => {
  const child = spawn(process.execPath, ["-e", `
    const { createServer } = require("node:http");
    const server = createServer((_request, response) => { response.statusCode = 503; response.end(); });
    server.listen(0, "127.0.0.1", () => {
      process.send({ type: "cca-server-ready", port: server.address().port });
      setTimeout(() => process.exit(1), 100);
    });
  `], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  await assert.rejects(waitForServerReady(child, 2_000), /退出（1）/);
  assert.equal(child.listenerCount("message"), 0);
});
