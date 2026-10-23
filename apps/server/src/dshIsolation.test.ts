import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import WebSocket, { WebSocketServer } from "ws";
import { DshManager, DshPool, type DshRuntime } from "./dshManager.js";
import { dshUserKey, ensureDshWorkspace } from "./dshProfile.js";
import { registerDshRoutes } from "./dshProxy.js";
import { store } from "./store.js";

function workspaceFixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-dsh-isolation-"));
  const previous = store.projects;
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  store.projects = ["alice", "bob"].map((ownerId) => {
    const projectPath = path.join(workspace, `${ownerId}-project`);
    fs.mkdirSync(projectPath);
    return { id: `${ownerId}-project`, name: `${ownerId} 的项目`, path: projectPath, ownerId };
  });
  t.after(() => {
    store.projects = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, workspace };
}

test("user workspace catalog excludes foreign, removed, and unowned projects and session references", (t) => {
  const { root, workspace } = workspaceFixture(t);
  const home = path.join(root, "alice-home");
  const fallbackPath = path.join(workspace, ".cca-users", dshUserKey("alice"));
  const scope = { ownerId: "alice", fallbackPath };
  ensureDshWorkspace(home, workspace, store.projects, scope);
  const file = path.join(home, "storages", "workspace.json");
  const current = JSON.parse(fs.readFileSync(file, "utf8"));
  current.tables.workspaces["cca-project-alice-project"].sessionIds = ["alice-session"];
  current.tables.workspaces.foreign = { path: store.projects[1]!.path, sessionIds: ["bob-session"] };
  current.tables.workspaces.removed = { path: path.join(workspace, "removed"), sessionIds: ["removed-session"] };
  current.global.workspaceIds.push("foreign", "removed");
  current.global.pinnedSessionIds = ["alice-session", "bob-session"];
  current.global.archivedSessionIds = ["removed-session", "alice-session"];
  fs.writeFileSync(file, JSON.stringify(current));

  ensureDshWorkspace(home, workspace, [
    ...store.projects,
    { id: "unowned", name: "unowned", path: path.join(workspace, "unowned") },
  ], scope);
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(state.tables.workspaces), ["cca-project-alice-project", "cca-default"]);
  assert.equal(state.tables.workspaces["cca-default"].path, path.resolve(fallbackPath));
  assert.notEqual(state.tables.workspaces["cca-default"].path, fs.realpathSync(workspace));
  assert.deepEqual(state.tables.workspaces["cca-project-alice-project"].sessionIds, ["alice-session"]);
  assert.deepEqual(state.global.pinnedSessionIds, ["alice-session"]);
  assert.deepEqual(state.global.archivedSessionIds, ["alice-session"]);

  ensureDshWorkspace(home, workspace, store.projects.filter((project) => project.ownerId !== "alice"), scope);
  const removed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(removed.global.workspaceIds, ["cca-default"]);
  assert.deepEqual(removed.global.pinnedSessionIds, []);
});

test("two accounts initialize separate homes without importing shared legacy history", async (t) => {
  const { root, workspace } = workspaceFixture(t);
  const keys = ["DSH_ENABLED", "DSH_HOME", "DSH_SANDBOX_ENABLED", "DSH_SANDBOX_WORKSPACE", "DSH_PROFILE_TEMPLATE"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  const template = path.join(root, "template");
  fs.mkdirSync(path.join(template, "node_modules"), { recursive: true });
  fs.writeFileSync(path.join(template, "package.json"), '{"name":"test-profile"}');
  const baseHome = path.join(root, "dsh-home");
  fs.mkdirSync(path.join(baseHome, "storages"), { recursive: true });
  const legacyFile = path.join(baseHome, "storages", "workspace.json");
  fs.writeFileSync(legacyFile, '{"legacy":"shared history"}');
  Object.assign(process.env, {
    DSH_ENABLED: "true", DSH_HOME: baseHome, DSH_SANDBOX_ENABLED: "false",
    DSH_SANDBOX_WORKSPACE: workspace, DSH_PROFILE_TEMPLATE: template,
  });
  const managers = [new DshManager("alice"), new DshManager("bob")];
  t.mock.method(console, "error", () => undefined);
  try {
    for (const manager of managers) {
      manager.start();
      // With no configured providers, initialization stops before spawning DSH.
      await assert.rejects(manager.waitUntilReady());
      const home = path.join(baseHome, "users", dshUserKey(manager.username));
      const state = JSON.parse(fs.readFileSync(path.join(home, "storages", "workspace.json"), "utf8"));
      assert.deepEqual(state.global.workspaceIds, [`cca-project-${manager.username}-project`, "cca-default"]);
    }
    assert.equal(fs.readFileSync(legacyFile, "utf8"), '{"legacy":"shared history"}');
    assert.notEqual(dshUserKey("../alice"), dshUserKey("alice"));
    assert.match(dshUserKey("../alice"), /^[0-9a-f]{64}$/);
  } finally {
    await Promise.all(managers.map((manager) => manager.close()));
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("DSH pool starts one instance per account and reloads only changed project ownership", async (t) => {
  workspaceFixture(t);
  const instances = new Map<string, DshRuntime>();
  const pool = new DshPool((username) => {
    const manager: DshRuntime = {
      start: t.mock.fn(), reload: t.mock.fn(), close: t.mock.fn(async () => undefined),
      status: () => ({ enabled: true, ready: true, starting: false, providerCount: 0, modelCount: 0 }),
      waitUntilReady: async () => undefined, upstreamPort: undefined, launchToken: undefined,
    };
    instances.set(username, manager);
    return manager;
  });
  const alice = pool.forUser("alice");
  const bob = pool.forUser("bob");
  const aliceReload = t.mock.method(alice, "reload");
  const bobReload = t.mock.method(bob, "reload");
  assert.notEqual(alice, bob);
  assert.equal(pool.forUser("alice"), alice);
  store.projects = store.projects.map((project) => project.ownerId === "bob"
    ? { ...project, name: "bob renamed" }
    : project);
  pool.forUser("alice");
  pool.forUser("bob");
  assert.equal(aliceReload.mock.callCount(), 0);
  assert.equal(bobReload.mock.callCount(), 1);
  store.projects = store.projects.map((project) => ({ ...project, ownerId: "alice" }));
  pool.forUser("alice");
  pool.forUser("bob");
  assert.equal(aliceReload.mock.callCount(), 1);
  assert.equal(bobReload.mock.callCount(), 2);
  await pool.close();
  assert.throws(() => pool.forUser("alice"), /正在关闭/);
});

async function proxyFixture(t: TestContext) {
  const runtimes = new Map<string, DshRuntime>();
  for (const username of ["alice", "bob"]) {
    const server = http.createServer((req, res) => {
      if (req.url === `/?token=launch-${username}`) {
        res.writeHead(303, { "set-cookie": `dsh_session=${username}-secret; Path=/; HttpOnly` });
        res.end();
      } else {
        const authorized = req.headers.cookie?.includes(`dsh_session=${username}-secret`);
        res.writeHead(authorized ? 200 : 401, {
          "content-type": "application/json",
          "set-cookie": `dsh_csrf=${username}; Path=/`,
        });
        res.end(JSON.stringify({ username, cookie: req.headers.cookie, auth: req.headers.authorization }));
      }
    });
    const wss = new WebSocketServer({ server });
    wss.on("connection", (socket, req) => {
      socket.on("message", () => socket.send(JSON.stringify({ username, cookie: req.headers.cookie })));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    runtimes.set(username, {
      start() {}, reload() {}, close: async () => undefined,
      status: () => ({ enabled: true, ready: true, starting: false, providerCount: 0, modelCount: 0, pid: address.port }),
      waitUntilReady: async () => undefined,
      upstreamPort: address.port, launchToken: `launch-${username}`,
    });
    t.after(async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
  }
  const valid = new Set(["alice", "bob"]);
  const app = Fastify();
  await app.register(websocket);
  registerDshRoutes(app, {
    managers: { forUser: (username) => runtimes.get(username)! },
    authenticate: (header) => {
      const username = header?.replace(/^Bearer /, "") ?? "";
      return valid.has(username) ? { username, role: "user" } : null;
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address !== "string");
  t.after(() => app.close());
  const enter = async (username: string, cookie?: string) => {
    const ticketResponse = await app.inject({
      method: "POST", url: "/api/dsh/ticket", headers: { authorization: `Bearer ${username}` },
    });
    const response = await app.inject({
      url: `/dsh/enter?ticket=${ticketResponse.json().ticket}`, headers: cookie ? { cookie } : {},
    });
    assert.equal(response.statusCode, 303);
    const cookies = response.headers["set-cookie"];
    assert.ok(Array.isArray(cookies));
    assert.equal(cookies.length, 1);
    assert.match(cookies[0]!, /^cca_dsh_session=/);
    assert.doesNotMatch(cookies[0]!, /secret/);
    return cookies[0]!.split(";", 1)[0]!;
  };
  const connect = async (cookie: string) => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/dsh/api/remote.mux`, { headers: { cookie } });
    t.after(() => socket.terminate());
    await once(socket, "open");
    return socket;
  };
  return { app, enter, connect, valid, runtimes };
}

test("DSH status and retry use authenticated ownership rather than a supplied username", async (t) => {
  const { app, runtimes } = await proxyFixture(t);
  const alice = runtimes.get("alice")!;
  const bob = runtimes.get("bob")!;
  const status = await app.inject({
    url: "/api/dsh/status?username=bob", headers: { authorization: "Bearer alice" },
  });
  assert.equal(status.json().pid, alice.upstreamPort);
  assert.notEqual(status.json().pid, bob.upstreamPort);
  const aliceReload = t.mock.method(alice, "reload");
  const bobReload = t.mock.method(bob, "reload");
  t.mock.method(alice, "status", () => ({
    enabled: true, ready: false, starting: false, providerCount: 0, modelCount: 0,
  }));
  await app.inject({
    method: "POST", url: "/api/dsh/retry?username=bob", headers: { authorization: "Bearer alice" },
  });
  assert.equal(aliceReload.mock.callCount(), 1);
  assert.equal(bobReload.mock.callCount(), 0);
});

test("DSH HTTP and WebSocket proxies select the cookie owner's instance and ignore supplied DSH cookies", async (t) => {
  const { app, enter, connect } = await proxyFixture(t);
  const alice = await enter("alice");
  const bob = await enter("bob");
  for (const [username, cookie] of [["alice", alice], ["bob", bob]]) {
    const response = await app.inject({ url: "/dsh/api/workspaces", headers: {
      cookie: `${cookie}; dsh_session=other-secret; unrelated=browser-cookie`,
    } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().username, username);
    assert.equal(response.json().cookie, `dsh_session=${username}-secret`);
    assert.equal(response.json().auth, undefined);
    assert.equal(response.headers["set-cookie"], undefined);
    const socket = await connect(cookie!);
    socket.send("inspect");
    const [message] = await once(socket, "message");
    assert.deepEqual(JSON.parse(message.toString()), {
      username, cookie: `dsh_session=${username}-secret; dsh_csrf=${username}`,
    });
    socket.close();
  }
  assert.equal((await app.inject({ url: "/dsh/api/workspaces", headers: {
    cookie: "dsh_session=alice-secret",
  } })).statusCode, 401);
});

test("switching account revokes the previous portal session and its WebSocket", async (t) => {
  const { app, enter, connect } = await proxyFixture(t);
  const alice = await enter("alice");
  const socket = await connect(alice);
  const closed = once(socket, "close");
  const bob = await enter("bob", alice);
  const [code] = await closed;
  assert.equal(code, 4401);
  assert.equal((await app.inject({ url: "/dsh/api/workspaces", headers: { cookie: alice } })).statusCode, 401);
  const current = await app.inject({ url: "/dsh/api/workspaces", headers: { cookie: bob } });
  assert.equal(current.json().username, "bob");
});

test("expired CCA credentials cannot redeem tickets or keep using a DSH portal", async (t) => {
  const { app, enter, valid } = await proxyFixture(t);
  const alice = await enter("alice");
  const ticketResponse = await app.inject({
    method: "POST", url: "/api/dsh/ticket", headers: { authorization: "Bearer alice" },
  });
  valid.delete("alice");
  const response = await app.inject({ url: `/dsh/enter?ticket=${ticketResponse.json().ticket}` });
  assert.equal(response.statusCode, 401);
  assert.equal((await app.inject({ url: "/dsh/api/workspaces", headers: { cookie: alice } })).statusCode, 401);
});
