import assert from "node:assert/strict";
import test from "node:test";
import { deriveProjectIdentity } from "./projectIdentity.js";

test("monogram uses first and last word initials, or first and last letter", () => {
  assert.equal(deriveProjectIdentity("autotest-platform").monogram, "AP");
  assert.equal(deriveProjectIdentity("automation-tests").monogram, "AT");
  assert.equal(deriveProjectIdentity("framia-magpie").monogram, "FM");
  assert.equal(deriveProjectIdentity("frontend").monogram, "FD");
  assert.equal(deriveProjectIdentity("cloud-coding-agent").monogram, "CA");
  assert.equal(deriveProjectIdentity("qqbot").monogram, "QT");
});

test("empty names fall back to PR and a stable hashed color", () => {
  const empty = deriveProjectIdentity("   ");
  const again = deriveProjectIdentity("");
  assert.equal(empty.monogram, "PR");
  assert.equal(again.monogram, "PR");
  assert.equal(empty.color, again.color);
});

test("the same project name always hashes to the same color", () => {
  const first = deriveProjectIdentity("autotest-platform");
  const second = deriveProjectIdentity(" Autotest-Platform ");
  assert.equal(first.color, second.color);
  assert.equal(first.monogram, second.monogram);
  assert.match(first.bgClassName, /bg-/);
  assert.match(first.textClassName, /text-/);
});
