import assert from "node:assert/strict";
import test from "node:test";
import { shouldShowNativeBrowser } from "./browserVisibility.js";

test("native browser visibility requires the panel and browser tab", () => {
  assert.equal(shouldShowNativeBrowser(true, "browser"), true);
  assert.equal(shouldShowNativeBrowser(false, "browser"), false);
  assert.equal(shouldShowNativeBrowser(true, "terminal"), false);
});
