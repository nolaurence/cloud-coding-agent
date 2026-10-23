import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setImmediate, setTimeout } from "node:timers/promises";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { DshManager, type DshStatus } from "./dshManager.js";
import { registerDshRoutes } from "./dshProxy.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-dsh-manager-"));
  const isConfigKey = (key: string) => key.startsWith("DSH_") || key === "CCA_PUBLIC_URL";
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => isConfigKey(key)));
  for (const key of Object.keys(process.env).filter(isConfigKey)) delete process.env[key];
  const helper = path.join(root, "helper.js");
  Object.assign(process.env, {
    DSH_ENABLED: "true",
    DSH_HOME: root,
    DSH_PROFILE_TEMPLATE: path.join(root, "missing-template"),
    DSH_SSH_HELPER_LOCAL: helper,
    DSH_SANDBOX_SSH_KEY: path.join(root, "missing-key"),
    DSH_SANDBOX_WORKSPACE: path.join(root, "workspace"),
    CCA_PUBLIC_URL: "http://example.test:8787",
  });
  const manager = new DshManager("user");
  t.mock.method(console, "error", () => undefined);
  t.after(async () => {
    await manager.close();
    for (const key of Object.keys(process.env).filter(isConfigKey)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { manager, helper };
}

async function waitForError(manager: DshManager, expected: RegExp, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (expected.test(manager.status().error ?? "")) return;
    await setTimeout(10);
  }
  assert.match(manager.status().error ?? "", expected);
}

test("DSH preserves the configuration error and automatically revalidates repaired files", async (t) => {
  const { manager, helper } = fixture(t);
  manager.start();
  await assert.rejects(manager.waitUntilReady(), /找不到 SSH helper 安装文件/);
  assert.doesNotMatch(manager.status().error ?? "", /配置尚未初始化/);

  fs.writeFileSync(helper, "// installed helper\n");
  // The next automatic attempt must pass configuration validation and reach
  // the next deployment check, without a CCA process restart.
  await waitForError(manager, /DSH profile 镜像模板不完整/, 4_000);
});

test("DSH reload re-resolves configuration immediately during retry backoff", async (t) => {
  const { manager } = fixture(t);
  process.env.DSH_SANDBOX_ENABLED = "false";
  process.env.CCA_PUBLIC_URL = "invalid-url";
  manager.start();
  await assert.rejects(manager.waitUntilReady(), /CCA_PUBLIC_URL 格式无效/);
  await setImmediate();

  process.env.CCA_PUBLIC_URL = "http://example.test:8787";
  manager.reload();
  await waitForError(manager, /DSH profile 镜像模板不完整/, 1_000);
});

test("disabled DSH does not validate missing runtime files or start a supervisor", async (t) => {
  const { manager } = fixture(t);
  process.env.DSH_ENABLED = "false";
  manager.start();
  manager.reload();
  assert.deepEqual(manager.status(), {
    enabled: false, ready: false, starting: false, error: undefined,
    providerCount: 0, modelCount: 0,
  });
});

test("DSH retry requires authentication and only wakes a failed launch", async (t) => {
  const manager = new DshManager("user");
  let status: DshStatus = {
    enabled: true, ready: false, starting: false, providerCount: 0, modelCount: 0,
    error: "找不到 SSH helper 安装文件",
  };
  t.mock.method(manager, "status", () => ({ ...status }));
  const reload = t.mock.method(manager, "reload", () => undefined);
  const app = Fastify();
  t.after(() => app.close());
  await app.register(websocket);
  registerDshRoutes(app, {
    managers: { forUser: () => manager },
    authenticate: (header) => header === "Bearer valid"
      ? { username: "user", role: "user" }
      : null,
  });

  const unauthorized = await app.inject({ method: "POST", url: "/api/dsh/retry" });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(reload.mock.callCount(), 0);

  const retry = () => app.inject({
    method: "POST", url: "/api/dsh/retry", headers: { authorization: "Bearer valid" },
  });
  assert.equal((await retry()).statusCode, 200);
  assert.equal(reload.mock.callCount(), 1);
  for (const next of [
    { ready: true, starting: false },
    { ready: false, starting: true },
  ]) {
    status = { ...status, ...next };
    assert.equal((await retry()).statusCode, 200);
    assert.equal(reload.mock.callCount(), 1);
  }
  status = { ...status, enabled: false, ready: false, starting: false };
  assert.equal((await retry()).statusCode, 503);
  assert.equal(reload.mock.callCount(), 1);
});

test("DSH logout clears the portal cookie below its path", async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  await app.register(websocket);
  registerDshRoutes(app, {
    managers: { forUser: () => ({}) as never },
    authenticate: () => null,
  });
  const response = await app.inject({ method: "POST", url: "/dsh/logout" });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["set-cookie"]), /cca_dsh_session=; Max-Age=0/);
});
