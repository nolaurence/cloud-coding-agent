import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { PermissionRequest } from "@github/copilot-sdk";
import { createWorkspacePermissionHandler } from "./permissions.js";

type WriteRequest = Extract<PermissionRequest, { kind: "write" }>;
type ShellRequest = Extract<PermissionRequest, { kind: "shell" }>;
type ReadRequest = Extract<PermissionRequest, { kind: "read" }>;

const invocation = { sessionId: "session" };

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-permissions-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cca-permissions-outside-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "inside.ts"), "export {};\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  return { root, outside, handler: createWorkspacePermissionHandler(root) };
}

function writeRequest(fileName: string, requestSandboxBypass = false): WriteRequest {
  return {
    kind: "write",
    fileName,
    diff: "",
    intention: "",
    canOfferSessionApproval: true,
    ...(requestSandboxBypass ? { requestSandboxBypass } : {}),
  };
}

function readRequest(target: string, requestSandboxBypass = false): ReadRequest {
  return {
    kind: "read",
    path: target,
    intention: "",
    ...(requestSandboxBypass ? { requestSandboxBypass } : {}),
  };
}

function shellRequest(overrides: Partial<ShellRequest>): ShellRequest {
  return {
    kind: "shell",
    fullCommandText: "",
    intention: "",
    commands: [],
    possiblePaths: [],
    possibleUrls: [],
    hasWriteFileRedirection: false,
    canOfferSessionApproval: true,
    ...overrides,
  };
}

test("approves workspace paths and pathless shell commands", async (t) => {
  const { root, handler } = fixture(t);
  assert.deepEqual(await handler(readRequest("src/inside.ts"), invocation), { kind: "approve-once" });
  assert.deepEqual(await handler(writeRequest(path.join(root, "src", "new.ts")), invocation), { kind: "approve-once" });
  assert.deepEqual(await handler(shellRequest({ commands: [{ identifier: "npm", readOnly: false }] }), invocation), { kind: "approve-once" });
});

test("rejects absolute, relative, and shell paths outside the workspace", async (t) => {
  const { root, outside, handler } = fixture(t);
  for (const target of [path.join(outside, "secret.txt"), path.resolve(root, "..", "escape"), "../../escape"]) {
    assert.equal((await handler(readRequest(target), invocation)).kind, "reject", target);
    assert.equal((await handler(writeRequest(target), invocation)).kind, "reject", target);
  }
  assert.equal((await handler(shellRequest({ possiblePaths: [path.join(root, "src"), outside] }), invocation)).kind, "reject");
});

test("rejects symbolic-link escapes for existing and new targets", async (t) => {
  const { root, outside, handler } = fixture(t);
  const link = path.join(root, "outside-link");
  try {
    fs.symlinkSync(outside, link, "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("当前环境不允许创建符号链接");
      return;
    }
    throw error;
  }
  assert.equal((await handler(readRequest(path.join(link, "secret.txt")), invocation)).kind, "reject");
  assert.equal((await handler(writeRequest(path.join(link, "new.txt")), invocation)).kind, "reject");
});

test("rejects sandbox bypasses and non-workspace capabilities by default", async (t) => {
  const { root, handler } = fixture(t);
  assert.equal((await handler(writeRequest(path.join(root, "new.ts"), true), invocation)).kind, "reject");
  assert.equal((await handler(shellRequest({ requestSandboxBypass: true }), invocation)).kind, "reject");

  const denied: PermissionRequest[] = [
    { kind: "mcp", readOnly: true, serverName: "server", toolName: "tool", toolTitle: "Tool" },
    { kind: "memory", fact: "secret" },
    { kind: "hook", toolName: "write" },
    { kind: "extension-management", operation: "reload" },
    { kind: "extension-permission-access", extensionName: "extension", capabilities: ["read"] },
    { kind: "custom-tool", toolName: "other", toolDescription: "Other tool" },
  ];
  for (const request of denied) {
    assert.equal((await handler(request, invocation)).kind, "reject", request.kind);
  }
});

test("only approves the registered custom tool and non-bypass URL access", async (t) => {
  const { handler } = fixture(t);
  assert.deepEqual(await handler({ kind: "custom-tool", toolName: "authenticated_git", toolDescription: "Git" }, invocation), { kind: "approve-once" });
  assert.deepEqual(await handler({ kind: "url", url: "https://example.com", intention: "fetch" }, invocation), { kind: "approve-once" });
  assert.equal((await handler({ kind: "url", url: "https://example.com", intention: "fetch", requestSandboxBypass: true }, invocation)).kind, "reject");
});

test("rejects non-existent workspace roots", () => {
  assert.throws(() => createWorkspacePermissionHandler("/path/that/does/not/exist"), /ENOENT/);
});
