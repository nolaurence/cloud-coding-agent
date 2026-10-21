import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexRpc } from "./codexRpc.js";

test("Codex startup failures classify storage errors without exposing stderr", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-rpc-failure-"));
  const previous = process.env.CCA_CODEX_PATH;
  // Node acts as a failing executable by running this fixture as its app-server script.
  process.env.CCA_CODEX_PATH = process.execPath;
  t.after(() => {
    if (previous === undefined) delete process.env.CCA_CODEX_PATH;
    else process.env.CCA_CODEX_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const diagnostic of ["No space left on device (os error 28)", "Disk quota exceeded", "ENOSPC", "Unrelated startup error"]) {
    await t.test(diagnostic, async () => {
      fs.writeFileSync(path.join(root, "app-server"), `
        process.stderr.write("https://private-provider.invalid?api_key=secret-token\\n" + ${JSON.stringify(diagnostic.slice(0, 8))});
        setTimeout(() => process.stderr.write(${JSON.stringify(diagnostic.slice(8))}, () => process.exit(1)), 20);
      `);
      const connection = new CodexRpc();
      const failures: Error[] = [];
      connection.onFailure = (error) => { failures.push(error); };
      try {
        await assert.rejects(connection.start(root, { ...process.env }), (error: Error) => {
          assert.equal(error.message, diagnostic === "Unrelated startup error"
            ? "Codex exited: 1"
            : "服务端磁盘空间或存储配额不足，请释放空间后重试");
          assert.equal(failures.length, 1);
          return true;
        });
      } finally { await connection.close(); }
    });
  }
});
