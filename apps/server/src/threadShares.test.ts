import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("thread share links persist as hashes and rotate or revoke access", async (t) => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "cca-shares-"));
  const originalDataDirectory = process.env.CCA_DATA_DIR;
  process.env.CCA_DATA_DIR = dataDirectory;

  const db = await import("./db.js");
  const shares = await import("./threadShares.js");
  t.after(async () => {
    if (db.usingDatabase()) await db.closeDb();
    if (originalDataDirectory === undefined) delete process.env.CCA_DATA_DIR;
    else process.env.CCA_DATA_DIR = originalDataDirectory;
    fs.rmSync(dataDirectory, { recursive: true, force: true });
  });

  await shares.initThreadShares();
  const first = await shares.createThreadShare("thread-1", "readonly", "owner");
  assert.equal(shares.validateThreadShareToken("thread-1", first.token), "readonly");
  assert.equal(shares.getSharedThreadAccess("thread-1", "__proto__"), null);
  await shares.redeemThreadShare(first.token, "__proto__");
  assert.equal(shares.getSharedThreadAccess("thread-1", "__proto__"), "readonly");
  assert.deepEqual(await shares.redeemThreadShare(first.token, "reader"), {
    threadId: "thread-1",
    mode: "readonly",
  });
  assert.equal(shares.getSharedThreadAccess("thread-1", "reader"), "readonly");

  const shareFile = path.join(dataDirectory, "thread-shares.json");
  const persisted = fs.readFileSync(shareFile, "utf8");
  assert.ok(!persisted.includes(first.token));
  assert.match(persisted, /"tokenHash": "[a-f\d]{64}"/);

  const second = await shares.createThreadShare("thread-1", "collaborate", "owner");
  assert.notEqual(second.token, first.token);
  assert.equal(shares.validateThreadShareToken("thread-1", first.token), null);
  assert.equal(shares.getSharedThreadAccess("thread-1", "reader"), null);
  await assert.rejects(() => shares.redeemThreadShare(first.token, "reader"), /无效或已失效/);

  await Promise.all([
    shares.redeemThreadShare(second.token, "collaborator"),
    shares.redeemThreadShare(second.token, "teammate"),
  ]);
  await shares.initThreadShares();
  assert.equal(shares.getSharedThreadAccess("thread-1", "collaborator"), "collaborate");
  assert.equal(shares.getSharedThreadAccess("thread-1", "teammate"), "collaborate");
  await shares.revokeThreadShare("thread-1");
  assert.equal(shares.getThreadShare("thread-1").active, false);
  assert.equal(shares.getSharedThreadAccess("thread-1", "collaborator"), null);
  await assert.rejects(() => shares.redeemThreadShare(second.token, "collaborator"), /无效或已失效/);

  const migrated = await shares.createThreadShare("thread-db", "collaborate", "owner");
  await shares.redeemThreadShare(migrated.token, "database-member");
  const databaseFile = path.join(dataDirectory, "shares.db");
  await db.initDb(`sqlite:${databaseFile.replaceAll(path.sep, "/")}`);
  await shares.initThreadShares();
  assert.equal(shares.getSharedThreadAccess("thread-db", "database-member"), "collaborate");
  const rows = await db.query<{ data: string }>(
    "SELECT data FROM thread_shares WHERE thread_id = ?",
    ["thread-db"],
  );
  assert.equal(rows.rows.length, 1);
  assert.ok(!rows.rows[0]!.data.includes(migrated.token));

  await db.closeDb();
  await db.initDb(`sqlite:${databaseFile.replaceAll(path.sep, "/")}`);
  await shares.initThreadShares();
  assert.equal(shares.getSharedThreadAccess("thread-db", "database-member"), "collaborate");
});
