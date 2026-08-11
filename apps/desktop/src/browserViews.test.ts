import assert from "node:assert/strict";
import test from "node:test";
import { isValidBrowserBounds, safeElectronBrowserUrl } from "./browserSecurity.js";

test("validates bounded native browser surfaces", () => {
  assert.equal(isValidBrowserBounds({ x: 10, y: 20, width: 800, height: 600 }), true);
  assert.equal(isValidBrowserBounds({ x: -1, y: 0, width: 800, height: 600 }), false);
  assert.equal(isValidBrowserBounds({ x: 0, y: 0, width: 0, height: 600 }), false);
  assert.equal(isValidBrowserBounds({ x: 0, y: 0, width: Number.NaN, height: 600 }), false);
});

test("desktop browser URL policy blocks credentials and loopback", async () => {
  await assert.rejects(safeElectronBrowserUrl("http://127.0.0.1:8787"), /禁止访问/);
  await assert.rejects(safeElectronBrowserUrl("http://user:pass@invalid.example"), /不含凭据/);
  await assert.rejects(safeElectronBrowserUrl("file:///etc/passwd"), /HTTP/);
});
