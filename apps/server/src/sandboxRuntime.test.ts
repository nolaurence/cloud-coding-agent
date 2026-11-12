import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifySandboxExecError,
  mapSandboxCwd,
  missingDirectoryResult,
  runMappedExec,
  SANDBOX_DIRECTORY_ERROR_CODE,
  SANDBOX_TIMEOUT_ERROR_CODE,
} from "./sandboxRuntime.js";

test("session host paths map onto /workspace before sandbox-looking prefixes", () => {
  assert.deepEqual(mapSandboxCwd(undefined, "/data/workspaces/demo"), { cwd: "/workspace" });
  assert.deepEqual(mapSandboxCwd("/data/workspaces/demo", "/data/workspaces/demo"), { cwd: "/workspace" });
  assert.deepEqual(mapSandboxCwd("/data/workspaces/demo/apps/web", "/data/workspaces/demo"), { cwd: "/workspace/apps/web" });
  assert.deepEqual(mapSandboxCwd("/workspace/apps/web", "/data/workspaces/demo"), { cwd: "/workspace/apps/web" });
  assert.deepEqual(mapSandboxCwd("apps/web", "/data/workspaces/demo"), { cwd: "/workspace/apps/web" });
  assert.equal(mapSandboxCwd("/etc/passwd", "/data/workspaces/demo").error, "cwd 不在沙箱工作区内: /etc/passwd");
  assert.equal(mapSandboxCwd("/workspace/../etc", "/data/workspaces/demo").error?.includes("沙箱工作区"), true);
});

test("CCA workspaces that themselves live under /workspace still map the host prefix first", () => {
  const host = "/workspace/alice/project";
  assert.deepEqual(mapSandboxCwd(host, host), { cwd: "/workspace" });
  assert.deepEqual(mapSandboxCwd(host + "/src", host), { cwd: "/workspace/src" });
  assert.deepEqual(mapSandboxCwd("/workspace", host), { cwd: "/workspace" });
});

test("killed child processes are classified as TIMEOUT, distinct from ordinary failures", () => {
  assert.deepEqual(classifySandboxExecError({ killed: true, signal: "SIGTERM", code: null }), {
    timedOut: true, errorCode: SANDBOX_TIMEOUT_ERROR_CODE, exitCode: 1,
  });
  assert.deepEqual(classifySandboxExecError({ killed: true, code: "ETIMEDOUT" }), {
    timedOut: true, errorCode: SANDBOX_TIMEOUT_ERROR_CODE, exitCode: 1,
  });
  assert.equal(classifySandboxExecError({ killed: false, code: 1 }).timedOut, false);
  assert.equal(classifySandboxExecError({ killed: false, code: 1 }).errorCode, undefined);
  assert.equal(missingDirectoryResult("/workspace/missing").errorCode, SANDBOX_DIRECTORY_ERROR_CODE);
  assert.match(missingDirectoryResult("/workspace/missing").stderr, /directory does not exist/);
});

test("runMappedExec reports a missing directory instead of spawn bash ENOENT", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-exec-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const missing = await runMappedExec("echo hi", { cwd: path.join(root, "nope"), sandboxRoot: root, hostWorkspace: root });
  assert.equal(missing.errorCode, SANDBOX_DIRECTORY_ERROR_CODE);
  assert.equal(missing.timedOut, false);
  assert.match(missing.stderr, /directory does not exist/);
  assert.equal(missing.stderr.includes("spawn"), false);
  assert.equal(missing.stderr.includes("/bin/bash"), false);
});

test("runMappedExec surfaces TIMEOUT when the subcommand exceeds timeout_ms", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-exec-timeout-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await runMappedExec("sleep 10", { cwd: root, sandboxRoot: root, hostWorkspace: root, timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.equal(result.errorCode, SANDBOX_TIMEOUT_ERROR_CODE);
});
