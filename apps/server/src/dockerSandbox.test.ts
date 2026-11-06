import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applySandboxChanges, DockerSandbox, readDockerSandboxConfig, snapshotWorkspace, validateWorkspaceName, type SandboxResult } from "./dockerSandbox.js";

const result = (files: Record<string, { data: string; executable: boolean }>, deleted: string[] = []): SandboxResult => ({
  stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false, files, deleted,
});
const entry = (text: string) => ({ data: Buffer.from(text).toString("base64"), executable: false });

test("explicit sandbox configuration fails closed when missing or malformed", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-sandbox-config-"));
  const previous = process.env.CCA_DOCKER_SANDBOX_CONFIG;
  t.after(async () => {
    if (previous === undefined) delete process.env.CCA_DOCKER_SANDBOX_CONFIG;
    else process.env.CCA_DOCKER_SANDBOX_CONFIG = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  const config = path.join(root, "config.json");
  process.env.CCA_DOCKER_SANDBOX_CONFIG = config;
  await assert.rejects(readDockerSandboxConfig(), /无法读取/);
  await fs.writeFile(config, JSON.stringify({ host: "-oProxyCommand=bad", username: "user" }));
  await assert.rejects(readDockerSandboxConfig(), /配置无效/);
});

test("workspace sync round trips binary files and deletions without exporting dependencies", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.writeFile(path.join(root, "node_modules", "ignored"), "dependency");
  await fs.writeFile(path.join(root, "old.txt"), "old");
  const before = await snapshotWorkspace(root);
  assert.deepEqual(Object.keys(before), ["old.txt"]);
  await applySandboxChanges(root, before, result({ "nested/binary.dat": { data: Buffer.from([0, 255, 1]).toString("base64"), executable: false } }, ["old.txt"]));
  assert.deepEqual(await fs.readFile(path.join(root, "nested/binary.dat")), Buffer.from([0, 255, 1]));
  await assert.rejects(fs.access(path.join(root, "old.txt")));
  assert.equal(await fs.readFile(path.join(root, "node_modules/ignored"), "utf8"), "dependency");
});

test("sync refuses traversal, reserved names, links and concurrent editor changes", async t => {
  for (const name of ["../escape", "/absolute", "C:/escape", "a\\b", "node_modules/x", "foo/CON", "trailing.", "a:b", "foo//bar"]) {
    assert.throws(() => validateWorkspaceName(name));
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-sync-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cca-outside-"));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); await fs.rm(outside, { recursive: true, force: true }); });
  await fs.writeFile(path.join(root, "file"), "before");
  const before = await snapshotWorkspace(root);
  await fs.writeFile(path.join(root, "file"), "editor");
  await assert.rejects(applySandboxChanges(root, before, result({ "new": entry("new"), file: entry("remote") })), /其他操作修改/);
  await assert.rejects(fs.access(path.join(root, "new")));
  assert.equal(await fs.readFile(path.join(root, "file"), "utf8"), "editor");
  await fs.symlink(outside, path.join(root, "link"), "junction");
  await assert.rejects(applySandboxChanges(root, before, result({ "link/escape": entry("escape") })), /符号链接/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("real Docker executes loops, persists files, bounds output and kills cancelled processes", {
  skip: !process.env.CCA_SANDBOX_INTEGRATION_CONFIG, timeout: 180000,
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-docker-integration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const config = JSON.parse(await fs.readFile(process.env.CCA_SANDBOX_INTEGRATION_CONFIG!, "utf8"));
  const sandbox = new DockerSandbox(config, "integration-" + Date.now(), root, false);
  t.after(() => sandbox.close());
  const first = await sandbox.run(`
    const results = [];
    for (let i = 0; i < 3; i++) {
      await tools.write_file('loop-' + i + '.txt', String(i));
      results.push(await tools.read_file('loop-' + i + '.txt'));
    }
    print(results);
    print(await tools.exec('id -u; test -f /.dockerenv && echo docker; touch /root/should-fail'));
    await tools.write_file('node_modules/persisted.txt', 'remote dependency');
  `);
  assert.equal(first.exitCode, 0, first.stderr);
  assert.match(first.stdout, /\["0","1","2"\]/);
  assert.match(first.stdout, /1000/);
  assert.match(first.stdout, /docker/);
  assert.match(first.stdout, /Permission denied|Read-only/);
  assert.equal(await fs.readFile(path.join(root, "loop-2.txt"), "utf8"), "2");
  await assert.rejects(fs.access(path.join(root, "node_modules")));
  const next = await sandbox.run(`print(await tools.read_file('node_modules/persisted.txt')); await tools.exec('rm loop-0.txt');`);
  assert.match(next.stdout, /remote dependency/);
  await assert.rejects(fs.access(path.join(root, "loop-0.txt")));
  const timeout = await sandbox.run(`await tools.write_file('before-timeout', 'saved'); while (true) {}`, 1500);
  assert.equal(timeout.timedOut, true);
  assert.equal(await fs.readFile(path.join(root, "before-timeout"), "utf8"), "saved");
  const pending = sandbox.run(`await tools.exec('sleep 20; echo escaped > cancelled-child');`, 30000);
  await new Promise(resolve => setTimeout(resolve, 1500));
  await sandbox.abort();
  assert.notEqual((await pending).exitCode, 0);
  // Yield so Node drains stdout; an infinite synchronous console loop can hit
  // Docker's memory limit before its buffered output reaches the gateway.
  const output = await sandbox.run(`console.log('x'.repeat(512 * 1024)); await new Promise(resolve => setTimeout(resolve, 10000));`, 15000);
  assert.equal(output.truncated, true, JSON.stringify({ ...output, stdout: output.stdout.slice(0, 100) }));
  assert.ok(output.stdout.length <= 256 * 1024);
  const final = await sandbox.run(`print(await tools.exec('test ! -f cancelled-child && echo clean'));`);
  assert.match(final.stdout, /clean/);
  const immediate = sandbox.run(`await tools.write_file('should-not-run', 'bad');`);
  const settled = immediate.then(value => value.exitCode !== 0, () => true);
  await sandbox.abort();
  assert.equal(await settled, true);
  await assert.rejects(fs.access(path.join(root, "should-not-run")));
});
