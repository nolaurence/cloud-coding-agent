import assert from "node:assert/strict";
import test from "node:test";
import {
  blockedResolvedAddress,
  hostnameIsIpLiteral,
  isBlockedSsrfAddress,
  isFakeIpAddress,
} from "./networkPolicy.js";

test("Fake-IP ranges are recognized without treating RFC1918 as Fake-IP", () => {
  assert.equal(isFakeIpAddress("198.18.0.1"), true);
  assert.equal(isFakeIpAddress("198.19.255.255"), true);
  assert.equal(isFakeIpAddress("198.17.0.1"), false);
  assert.equal(isFakeIpAddress("198.20.0.1"), false);
  assert.equal(isFakeIpAddress("10.0.0.1"), false);
  assert.equal(isFakeIpAddress("192.168.1.1"), false);
  assert.equal(isFakeIpAddress("2001:2::1"), true);
  assert.equal(isFakeIpAddress("2001:2:0:0:0:0:0:1"), true);
  assert.equal(isFakeIpAddress("::1"), false);
});

test("SSRF still blocks private, loopback, link-local and metadata addresses", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "192.168.0.9", "172.16.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1"]) {
    assert.equal(isBlockedSsrfAddress(address), true, address);
    assert.equal(isBlockedSsrfAddress(address, { allowFakeIp: true }), true, address);
  }
  assert.equal(isBlockedSsrfAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedSsrfAddress("8.8.8.8"), false);
});

test("hostname Fake-IP answers are allowed; IP literals in the same range are not", () => {
  assert.equal(isBlockedSsrfAddress("198.18.4.133", { allowFakeIp: true }), false);
  assert.equal(isBlockedSsrfAddress("198.18.4.133", { allowFakeIp: false }), true);
  assert.equal(blockedResolvedAddress("example.com", ["198.18.0.10"]), undefined);
  assert.equal(blockedResolvedAddress("198.18.0.10", ["198.18.0.10"]), "198.18.0.10");
  assert.equal(blockedResolvedAddress("example.com", ["8.8.8.8", "10.0.0.1"]), "10.0.0.1");
  assert.equal(blockedResolvedAddress("example.com", ["8.8.8.8"]), undefined);
  assert.equal(hostnameIsIpLiteral("example.com"), false);
  assert.equal(hostnameIsIpLiteral("198.18.0.1"), true);
  assert.equal(hostnameIsIpLiteral("::1"), true);
});
