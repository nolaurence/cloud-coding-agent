import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionRequest } from "@github/copilot-sdk";
import { createWorkspacePermissionHandler } from "./permissions.js";

const invocation = { sessionId: "session" };

test("approves file, shell, and URL requests", async () => {
  const handler = createWorkspacePermissionHandler();
  const requests: PermissionRequest[] = [
    { kind: "read", path: "/etc/hostname", intention: "" },
    { kind: "write", fileName: "/tmp/new.ts", diff: "", intention: "", canOfferSessionApproval: true },
    { kind: "shell", fullCommandText: "", intention: "", commands: [], possiblePaths: [], possibleUrls: [], hasWriteFileRedirection: false, canOfferSessionApproval: true },
    { kind: "url", url: "https://example.com", intention: "fetch" },
  ];
  for (const request of requests) {
    assert.deepEqual(await handler(request, invocation), { kind: "approve-once" }, request.kind);
  }
});

test("only approves registered custom tools", async () => {
  const handler = createWorkspacePermissionHandler();
  for (const toolName of ["authenticated_git", "manage_skills", "manage_mcp_servers"]) {
    assert.deepEqual(await handler({ kind: "custom-tool", toolName, toolDescription: toolName }, invocation), { kind: "approve-once" });
  }
  assert.equal((await handler({ kind: "custom-tool", toolName: "other", toolDescription: "Other tool" }, invocation)).kind, "reject");
});

test("rejects disabled features", async () => {
  const handler = createWorkspacePermissionHandler();
  const denied: PermissionRequest[] = [
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
  const request = (serverName: string): PermissionRequest => ({
    kind: "mcp",
    readOnly: true,
    serverName,
    toolName: "tool",
    toolTitle: "Tool",
  });
  assert.equal((await handler(request("allowed"), invocation)).kind, "approve-once");
  assert.equal((await handler(request("blocked"), invocation)).kind, "reject");
});
