import assert from "node:assert/strict";
import test from "node:test";
import { connect, disconnect, downloadFile, downloadProjectFile } from "./client.js";

test("file downloads authenticate, encode paths and preserve the original binary blob", async (context) => {
  const link = { href: "", download: "", click: context.mock.fn(), remove: context.mock.fn() };
  const append = context.mock.fn();
  const blob = new Blob([new Uint8Array([0, 255, 128])]);
  const fetchMock = context.mock.fn(async () => new Response(blob));
  let cleanup: (() => void) | undefined;
  context.mock.method(globalThis, "fetch", fetchMock);
  context.mock.method(URL, "createObjectURL", (value: Blob) => { assert.deepEqual(value.size, blob.size); return "blob:download"; });
  const revoke = context.mock.method(URL, "revokeObjectURL", () => {});
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    location: { protocol: "http:", host: "localhost" },
    WebSocket: class { close() {} },
    document: { createElement: () => link, body: { append } },
    window: { setTimeout: (callback: () => void) => { cleanup = callback; } },
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, value });
  }
  context.after(() => {
    disconnect();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  });
  await assert.rejects(downloadProjectFile("project", "file"), /未登录/);
  connect("test-token");
  const filePath = "src/报告 #100%.bin";
  await downloadProjectFile("project/id", filePath);
  assert.deepEqual(fetchMock.mock.calls[0]?.arguments, [
    `/api/projects/project%2Fid/files/download?path=${encodeURIComponent(filePath)}`,
    { headers: { Authorization: "Bearer test-token" } },
  ]);
  assert.equal(link.download, "报告 #100%.bin");
  assert.equal(link.href, "blob:download");
  assert.equal(append.mock.callCount(), 1);
  assert.equal(link.click.mock.callCount(), 1);
  assert.equal(link.remove.mock.callCount(), 1);
  cleanup?.();
  assert.deepEqual(revoke.mock.calls[0]?.arguments, ["blob:download"]);
  await downloadFile("attachment/id", "附件.bin", "thread/id", "share-token");
  assert.deepEqual(fetchMock.mock.calls[1]?.arguments, [
    "/api/uploads/files/attachment%2Fid?threadId=thread%2Fid",
    { headers: { Authorization: "Bearer test-token", "X-Thread-Share-Token": "share-token" } },
  ]);
  fetchMock.mock.mockImplementation(async () => new Response(JSON.stringify({ error: "无权访问" }), { status: 403 }));
  await assert.rejects(downloadProjectFile("project", "file"), /无权访问/);
  fetchMock.mock.mockImplementation(async () => new Response("unavailable", { status: 503 }));
  await assert.rejects(downloadProjectFile("project", "file"), /503/);
  assert.equal(link.click.mock.callCount(), 2);
});
