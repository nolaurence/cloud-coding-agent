import assert from "node:assert/strict";
import test from "node:test";
import {
  ARCHIVED_THREAD_RETENTION_MS,
  archivedThreadExpiresAt,
  isArchivedThreadExpired,
} from "@cca/protocol";

test("archived threads expire only after the 30 day retention window", () => {
  const archivedAt = 1_000_000;
  const thread = { archived: true, archivedAt };

  assert.equal(archivedThreadExpiresAt(thread), archivedAt + ARCHIVED_THREAD_RETENTION_MS);
  assert.equal(
    isArchivedThreadExpired(thread, archivedAt + ARCHIVED_THREAD_RETENTION_MS - 1),
    false,
  );
  assert.equal(
    isArchivedThreadExpired(thread, archivedAt + ARCHIVED_THREAD_RETENTION_MS),
    true,
  );
});

test("legacy archived threads without a timestamp are never auto-deleted", () => {
  assert.equal(archivedThreadExpiresAt({}), null);
  assert.equal(isArchivedThreadExpired({ archived: true }, Date.now()), false);
});
