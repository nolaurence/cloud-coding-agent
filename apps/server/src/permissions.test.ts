import assert from "node:assert/strict";
import test from "node:test";
import type { ToolPermissionRequest } from "@cca/protocol";
import { createWorkspacePermissionHandler } from "./permissions.js";

const invocation = { sessionId: "session" };

test("approves file, shell, and URL requests", async () => {
  const handler = createWorkspacePermissionHandler();
  const requests: ToolPermissionRequest[] = [
    { kind: "read", fileName: "/etc/hostname" },
    { kind: "write", fileName: "/tmp/new.ts", diff: "" },
    { kind: "shell", commands: [] },
    { kind: "url", url: "https://example.com" },
  ];
  for (const request of requests) {
    assert.deepEqual(await handler(request, invocation), { kind: "approve-once" }, request.kind);
  }
});

test("only approves registered custom tools", async () => {
  const handler = createWorkspacePermissionHandler();
  for (const toolName of ["authenticated_git", "manage_skills", "manage_mcp_servers"]) {
    assert.deepEqual(await handler({ kind: "custom-tool", toolName }, invocation), { kind: "approve-once" });
  }
  assert.equal((await handler({ kind: "custom-tool", toolName: "other" }, invocation)).kind, "reject");
});

test("rejects disabled features", async () => {
  const handler = createWorkspacePermissionHandler();
  const denied: ToolPermissionRequest[] = [
    { kind: "memory", fact: "secret" },
    { kind: "hook", toolName: "write" },
    { kind: "extension-management", operation: "reload" },
    { kind: "extension-permission-access", extensionName: "extension", capabilities: ["read"] },
  ];
  for (const request of denied) {
    assert.equal((await handler(request, invocation)).kind, "reject", request.kind);
  }
});

test("only approves MCP servers explicitly enabled for the session", async () => {
  const handler = createWorkspacePermissionHandler(new Set(["allowed"]));
  const request = (serverName: string): ToolPermissionRequest => ({
    kind: "mcp",
    serverName,
    toolName: "tool",
  });
  assert.equal((await handler(request("allowed"), invocation)).kind, "approve-once");
  assert.equal((await handler(request("blocked"), invocation)).kind, "reject");
});
