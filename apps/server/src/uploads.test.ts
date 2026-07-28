import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { TurnAttachment } from "@cca/protocol";
import { validateTurnAttachments } from "./uploads.js";

function fixture(t: TestContext) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cca-upload-workspace-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cca-upload-outside-"));
  fs.mkdirSync(path.join(workspace, "src"));
  fs.writeFileSync(path.join(workspace, "src", "inside.ts"), "export {};\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  t.after(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });
  return { workspace, outside };
}

test("resolves relative file attachments inside the workspace", (t) => {
  const { workspace } = fixture(t);
  const attachments: TurnAttachment[] = [{ path: "src/inside.ts", displayName: "src/inside.ts" }];

  validateTurnAttachments("user", workspace, attachments);

  assert.equal(attachments[0]?.path, fs.realpathSync(path.join(workspace, "src", "inside.ts")));
});

test("rejects outside and missing file attachments", (t) => {
  const { workspace, outside } = fixture(t);
  for (const target of [path.join(outside, "secret.txt"), "../outside.txt", "missing.txt"]) {
    const attachments: TurnAttachment[] = [{ path: target, displayName: "file" }];
    assert.throws(() => validateTurnAttachments("user", workspace, attachments), /不属于当前工作区/);
  }
});

test("rejects attachments reached through an escaping symbolic link", (t) => {
  const { workspace, outside } = fixture(t);
  try {
    fs.symlinkSync(outside, path.join(workspace, "outside-link"), "junction");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("当前环境不允许创建符号链接");
      return;
    }
    throw error;
  }
  const attachments: TurnAttachment[] = [{ path: "outside-link/secret.txt", displayName: "secret.txt" }];
  assert.throws(() => validateTurnAttachments("user", workspace, attachments), /不属于当前工作区/);
});
