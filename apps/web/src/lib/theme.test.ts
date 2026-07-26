import assert from "node:assert/strict";
import test from "node:test";
import { resolveTheme, THEME_OPTIONS } from "./theme.js";

test("theme options keep system, light, and dark in the settings order", () => {
  assert.deepEqual(
    THEME_OPTIONS.map((option) => option.value),
    ["system", "light", "dark"],
  );
});

test("system theme follows the supplied system preference", () => {
  assert.equal(resolveTheme("system", false), "light");
  assert.equal(resolveTheme("system", true), "dark");
  assert.equal(resolveTheme("light", true), "light");
  assert.equal(resolveTheme("dark", false), "dark");
});
