import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionRequest } from "@github/copilot-sdk";

type PermissionRequestWrite = Extract<PermissionRequest, { kind: "write" }>;
type PermissionRequestShell = Extract<PermissionRequest, { kind: "shell" }>;
type PermissionRequestRead = Extract<PermissionRequest, { kind: "read" }>;
import { createWorkspacePermissionHandler } from "./permissions.js";

const handler = createWorkspacePermissionHandler("/projects/demo");
const invocation = { sessionId: "s" };

function writeRequest(fileName: string): PermissionRequestWrite {
  return {
    kind: "write",
    fileName,
    diff: "",
    intention: "",
    canOfferSessionApproval: true,
  };
}

function shellRequest(
  overrides: Partial<PermissionRequestShell>,
): PermissionRequestShell {
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

test("approves writes under /projects", async () => {
  const result = await handler(writeRequest("/projects/demo/a.ts"), invocation);
  assert.deepEqual(result, { kind: "approve-once" });
});

test("approves relative writes resolved against the project directory", async () => {
  const result = await handler(writeRequest("src/a.ts"), invocation);
  assert.deepEqual(result, { kind: "approve-once" });
});

test("approves writes under /workspace", async () => {
  const result = await handler(writeRequest("/workspace/x.txt"), invocation);
  assert.deepEqual(result, { kind: "approve-once" });
});

test("rejects writes outside writable roots", async () => {
  for (const target of ["/etc/passwd", "/tmp/x", "/projectsx/evil", "../../outside"]) {
    const result = await handler(writeRequest(target), invocation);
    assert.equal(result.kind, "reject", target);
  }
});

test("approves read-only shell commands anywhere", async () => {
  const result = await handler(
    shellRequest({
      commands: [{ identifier: "cat", readOnly: true }],
      possiblePaths: ["/etc/hostname"],
    }),
    invocation,
  );
  assert.deepEqual(result, { kind: "approve-once" });
});

test("approves mutating shell commands scoped to writable roots", async () => {
  const result = await handler(
    shellRequest({
      commands: [{ identifier: "rm", readOnly: false }],
      possiblePaths: ["/projects/demo/dist"],
    }),
    invocation,
  );
  assert.deepEqual(result, { kind: "approve-once" });
});

test("approves mutating shell commands without paths in a writable project", async () => {
  const result = await handler(
    shellRequest({ commands: [{ identifier: "npm", readOnly: false }] }),
    invocation,
  );
  assert.deepEqual(result, { kind: "approve-once" });
});

test("rejects shell writes outside writable roots", async () => {
  const redirected = await handler(
    shellRequest({
      hasWriteFileRedirection: true,
      possiblePaths: ["/tmp/out"],
    }),
    invocation,
  );
  assert.equal(redirected.kind, "reject");

  const mixed = await handler(
    shellRequest({
      commands: [{ identifier: "cp", readOnly: false }],
      possiblePaths: ["/projects/demo/a", "/var/lib/b"],
    }),
    invocation,
  );
  assert.equal(mixed.kind, "reject");
});

test("rejects sandbox bypass requests", async () => {
  const result = await handler(
    shellRequest({ requestSandboxBypass: true }),
    invocation,
  );
  assert.equal(result.kind, "reject");
});

test("rejects mutating commands when the project itself is outside writable roots", async () => {
  const outside = createWorkspacePermissionHandler("/opt/app");
  const result = await outside(
    shellRequest({ commands: [{ identifier: "make", readOnly: false }] }),
    invocation,
  );
  assert.equal(result.kind, "reject");
});

test("approves other request kinds (read, mcp, url)", async () => {
  const read: PermissionRequestRead = {
    kind: "read",
    path: "/etc/hosts",
    intention: "",
  };
  const result = await handler(read, invocation);
  assert.deepEqual(result, { kind: "approve-once" });
});
