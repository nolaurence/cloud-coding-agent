import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@github/copilot-sdk";
import { initDb, closeDb, query } from "./db.js";
import { ThreadEventStore, deleteThreadEvents } from "./threadEvents.js";

function event(id: string): SessionEvent {
  return { id, parentId: null, timestamp: new Date().toISOString(), type: "user.message", data: { content: id } };
}

test("event batches preserve ordering, isolate threads and replay idempotently", async () => {
  await initDb("sqlite::memory:");
  try {
    const errors: unknown[] = [];
    const first = new ThreadEventStore("first", (error) => errors.push(error));
    const second = new ThreadEventStore("second", (error) => errors.push(error));
    for (let i = 1; i <= 205; i++) first.append(event(String(i)), i);
    second.append(event("1"), 1);
    await first.flush();
    const replay = new ThreadEventStore("first", (error) => errors.push(error));
    for (let i = 1; i <= 205; i++) replay.append(event(String(i)), i);
    assert.equal((await replay.read()).length, 205);
    assert.equal((await replay.read())[204]?.id, "205");
    await deleteThreadEvents("first");
    assert.deepEqual(await first.read(), []);
    assert.equal((await second.read()).length, 1);
    assert.deepEqual(errors, []);
  } finally { await closeDb(); }
});

test("database failures are reported and flush rejects rather than claiming durability", async () => {
  await initDb("sqlite::memory:");
  try {
    const errors: unknown[] = [];
    const store = new ThreadEventStore("broken", (error) => errors.push(error));
    await query("DROP TABLE thread_events");
    store.append(event("1"), 1);
    await assert.rejects(store.flush(), /thread_events/);
    assert.equal(errors.length, 1);
  } finally { await closeDb(); }
});
