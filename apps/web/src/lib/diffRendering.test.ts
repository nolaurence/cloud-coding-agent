import assert from "node:assert/strict";
import test from "node:test";
import {
  buildFileDiffRenderKey,
  buildPatchCacheKey,
  getRenderablePatch,
  resolveFileDiffPath,
} from "./diffRendering.js";

const PATCH = `diff --git a/src/example.ts b/src/example.ts
index 1111111..2222222 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -1 +1 @@
-export const value = 1;
+export const value = 2;
`;

test("diff rendering parses Git patches into stable file items", () => {
  const first = getRenderablePatch(PATCH, "test");
  const second = getRenderablePatch(PATCH, "test");

  assert.equal(first?.kind, "files");
  assert.equal(second?.kind, "files");
  if (first?.kind !== "files" || second?.kind !== "files") return;
  assert.equal(first.files.length, 1);
  const file = first.files[0];
  assert.ok(file);
  assert.equal(resolveFileDiffPath(file), "src/example.ts");
  assert.equal(buildFileDiffRenderKey(file), buildFileDiffRenderKey(second.files[0]!));
  assert.equal(buildPatchCacheKey(PATCH, "test"), buildPatchCacheKey(PATCH, "test"));
});

test("diff rendering falls back to raw text for unsupported patches", () => {
  assert.deepEqual(getRenderablePatch("not a Git patch", "test"), {
    kind: "raw",
    text: "not a Git patch",
    reason: "暂不支持该差异格式，已显示原始补丁。",
  });
  assert.equal(getRenderablePatch("  ", "test"), null);
});
