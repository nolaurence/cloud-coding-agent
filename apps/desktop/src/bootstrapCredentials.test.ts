import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadOrCreateDesktopCredentials, markDesktopCredentialsRevealed } from "./bootstrapCredentials.js";

test("creates strong persistent desktop credentials without rotating", (t) => {
  const directory = path.resolve(`.desktop-credentials-test-${process.pid}`);
  fs.rmSync(directory, { recursive: true, force: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const first = loadOrCreateDesktopCredentials(directory);
  const second = loadOrCreateDesktopCredentials(directory);
  assert.equal(first.shouldReveal, true);
  assert.equal(second.shouldReveal, true);
  markDesktopCredentialsRevealed(directory);
  const third = loadOrCreateDesktopCredentials(directory);
  assert.equal(third.shouldReveal, false);
  assert.equal(second.username, first.username);
  assert.equal(second.password, first.password);
  assert.match(first.password, /^[A-Za-z0-9_-]{40,}$/);
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(directory, "desktop-admin.json")).mode & 0o777, 0o600);
});

test("rejects corrupted desktop credentials instead of silently rotating", (t) => {
  const directory = path.resolve(`.desktop-credentials-invalid-${process.pid}`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "desktop-admin.json"), "{}", "utf8");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => loadOrCreateDesktopCredentials(directory), /invalid desktop credentials/);
});

test("recovers an interrupted credential replacement from backup", (t) => {
  const directory = path.resolve(`.desktop-credentials-backup-${process.pid}`);
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, "desktop-admin.json");
  const stored = { username: "desktop-admin", password: "x".repeat(43), revealed: false };
  fs.writeFileSync(`${filename}.backup`, JSON.stringify(stored), "utf8");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recovered = loadOrCreateDesktopCredentials(directory);
  assert.equal(recovered.password, stored.password);
  assert.equal(fs.existsSync(`${filename}.backup`), false);
});

test("prefers a completed replacement over a stale backup", (t) => {
  const directory = path.resolve(`.desktop-credentials-stale-${process.pid}`);
  fs.mkdirSync(directory, { recursive: true });
  const filename = path.join(directory, "desktop-admin.json");
  fs.writeFileSync(filename, JSON.stringify({ username: "desktop-admin", password: "n".repeat(43), revealed: true }), "utf8");
  fs.writeFileSync(`${filename}.backup`, JSON.stringify({ username: "desktop-admin", password: "o".repeat(43), revealed: false }), "utf8");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const recovered = loadOrCreateDesktopCredentials(directory);
  assert.equal(recovered.password, "n".repeat(43));
  assert.equal(fs.existsSync(`${filename}.backup`), false);
});
