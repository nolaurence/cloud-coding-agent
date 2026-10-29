import assert from "node:assert/strict";
import test from "node:test";
import { isPreReleaseHost } from "./connectorEnvironment.js";

test("pre hostnames select the pre-release environment", () => {
  assert.equal(isPreReleaseHost("pre.example.com"), true);
  assert.equal(isPreReleaseHost("PRE.example.com:8787"), true);
});

test("hostnames without a pre prefix select production", () => {
  assert.equal(isPreReleaseHost("example.com"), false);
  assert.equal(isPreReleaseHost("prod.example.com"), false);
  assert.equal(isPreReleaseHost("192.168.100.130:8787"), false);
});
