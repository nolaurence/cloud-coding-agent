import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEvent } from "@github/copilot-sdk";
import { initDb, closeDb, query } from "./db.js";
import { ThreadEventStore, copyThreadEvents, deleteThreadEvents } from "./threadEvents.js";

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

test("copying thread events duplicates history onto a new thread id", async () => {
  await initDb("sqlite::memory:");
  try {
    const source = new ThreadEventStore("source", () => {});
    source.append(event("a"), 1);
    source.append(event("b"), 2);
    await source.flush();
    await copyThreadEvents("source", "forked");
    const copied = new ThreadEventStore("forked", () => {});
    assert.deepEqual((await copied.read()).map((item) => item.id), ["a", "b"]);
    assert.deepEqual((await source.read()).map((item) => item.id), ["a", "b"]);
    await copyThreadEvents("source", "forked");
    assert.equal((await copied.read()).length, 2);
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
