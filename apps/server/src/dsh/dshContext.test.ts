import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readDshContextBreakdown } from "./dshContext.js";

test("reads the DSH context breakdown projection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-dsh-context-"));
  const threadId = "thread-1";
  const directory = path.join(root, threadId, "storages", "session_projcache", "sessions");
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, `${threadId}.json`),
      JSON.stringify({
        record: {
          rows: {
            contextBreakdown: {
              val: {
                breakdown: { systemTokens: 1400, toolsTokens: 7400, messageTokens: 36400 },
              },
            },
          },
        },
      }),
    );
    assert.deepEqual(readDshContextBreakdown(threadId, root), {
      systemTokens: 1400,
      toolsTokens: 7400,
      messageTokens: 36400,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("returns undefined for missing, malformed, or invalid projections", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-dsh-context-"));
  try {
    assert.equal(readDshContextBreakdown("thread-1", root), undefined);
    assert.equal(readDshContextBreakdown("../escape", root), undefined);
    const directory = path.join(root, "thread-1", "storages", "session_projcache", "sessions");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "thread-1.json"), "not json");
    assert.equal(readDshContextBreakdown("thread-1", root), undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
