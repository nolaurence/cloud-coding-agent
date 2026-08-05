import assert from "node:assert/strict";
import test from "node:test";
import type { CopilotClient } from "@github/copilot-sdk";
import { buildWorkspaceSandboxConfig, installWorkspaceSandbox } from "./sandbox.js";

test("builds a sandbox config scoped to the workspace", () => {
  const config = buildWorkspaceSandboxConfig("/workspace/a", [
    "/data",
    "/workspace/b",
    "/workspace/a",
    "/workspace/b",
  ]);
  assert.deepEqual(config, {
    enabled: true,
    addCurrentWorkingDirectory: true,
    userPolicy: {
      filesystem: {
        readwritePaths: ["/workspace/a"],
        deniedPaths: ["/data", "/workspace/b"],
      },
    },
  });
});

test("injects sandboxConfig into session.create and session.resume", async () => {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const client = {
    connection: {
      sendRequest: async (method: string, params?: unknown) => {
        requests.push({ method, params: (params ?? {}) as Record<string, unknown> });
        return {};
      },
    },
  } as unknown as CopilotClient;

  installWorkspaceSandbox(client, () => ["/data", "/workspace/other"]);

  const connection = (client as unknown as {
    connection: { sendRequest: (method: string, params?: unknown) => Promise<unknown> };
  }).connection;

  await connection.sendRequest("session.create", { workingDirectory: "/workspace/a" });
  await connection.sendRequest("session.resume", {
    sessionId: "t1",
    workingDirectory: "/workspace/a",
  });
  await connection.sendRequest("session.list", {});
  await connection.sendRequest("session.create", { workingDirectory: 42 });
  await connection.sendRequest("session.create", {
    workingDirectory: "/workspace/a",
    sandboxConfig: { enabled: false },
  });

  const expected = buildWorkspaceSandboxConfig("/workspace/a", ["/data", "/workspace/other"]);
  assert.deepEqual(requests[0]?.params.sandboxConfig, expected);
  assert.deepEqual(requests[1]?.params.sandboxConfig, expected);
  assert.equal(requests[2]?.params.sandboxConfig, undefined);
  assert.equal(requests[3]?.params.sandboxConfig, undefined);
  assert.deepEqual(requests[4]?.params.sandboxConfig, { enabled: false });
});

test("throws when the SDK connection is unavailable", () => {
  assert.throws(
    () => installWorkspaceSandbox({} as CopilotClient, () => []),
    /沙箱/,
  );
});
