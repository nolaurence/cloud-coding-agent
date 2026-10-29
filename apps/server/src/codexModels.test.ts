import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hasNativeCodexAuth } from "./codex.js";

test("native Codex model discovery requires an auth.json", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cca-codex-auth-"));
  try {
    assert.equal(hasNativeCodexAuth(home), false);
    fs.writeFileSync(path.join(home, "auth.json"), "{}", { mode: 0o600 });
    assert.equal(hasNativeCodexAuth(home), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
