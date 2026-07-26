import assert from "node:assert/strict";
import test from "node:test";
import { FileAutosaver, type FileSaveState } from "./fileAutosaver.js";

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await delay(5);
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("debounces changes and persists only the latest content", async () => {
  const writes: string[] = [];
  const states: FileSaveState[] = [];
  const saver = new FileAutosaver({
    initialContent: "initial",
    debounceMs: 25,
    persist: async (content) => {
      writes.push(content);
      return content.length;
    },
    onState: (state) => states.push(state),
  });

  saver.change("first");
  await delay(10);
  saver.change("latest");

  assert.deepEqual(writes, []);
  await waitFor(() => writes.length === 1);
  await waitFor(() => saver.state.status === "saved");
  assert.deepEqual(writes, ["latest"]);
  assert.equal(states[0]?.status, "dirty");
  assert.equal(states.at(-1)?.status, "saved");
});

test("serializes writes and follows an in-flight save with the latest content", async () => {
  const calls: string[] = [];
  const completions: Array<ReturnType<typeof deferred<string>>> = [];
  let active = 0;
  let maxActive = 0;
  const saver = new FileAutosaver({
    initialContent: "initial",
    debounceMs: 15,
    persist: (content) => {
      calls.push(content);
      active += 1;
      maxActive = Math.max(maxActive, active);
      const completion = deferred<string>();
      completions.push(completion);
      return completion.promise.finally(() => {
        active -= 1;
      });
    },
    onState: () => undefined,
  });

  saver.change("one");
  await waitFor(() => calls.length === 1);

  saver.change("two");
  await delay(25);
  assert.deepEqual(calls, ["one"]);
  assert.equal(maxActive, 1);

  completions[0]!.resolve("one");
  await waitFor(() => calls.length === 2);
  assert.deepEqual(calls, ["one", "two"]);
  assert.equal(maxActive, 1);

  completions[1]!.resolve("two");
  await waitFor(() => saver.state.status === "saved");
  assert.equal(saver.state.status, "saved");
  assert.equal(saver.dirty, false);
});

test("retains an error and retries the dirty content", async () => {
  const attempts: string[] = [];
  const states: FileSaveState[] = [];
  const saver = new FileAutosaver({
    initialContent: "initial",
    debounceMs: 1_000,
    persist: async (content) => {
      attempts.push(content);
      if (attempts.length === 1) throw new Error("offline");
      return "ok";
    },
    onState: (state) => states.push(state),
  });

  saver.change("changed");
  await saver.flush();
  assert.deepEqual(saver.state, { status: "error", message: "offline" });
  assert.equal(saver.dirty, true);
  assert.deepEqual(attempts, ["changed"]);

  await saver.retry();
  assert.deepEqual(attempts, ["changed", "changed"]);
  assert.equal(saver.state.status, "saved");
  assert.equal(saver.dirty, false);
  assert.ok(states.some((state) => state.status === "error"));
});

test("dispose flushes pending content and ignores later changes", async () => {
  const writes: string[] = [];
  const saver = new FileAutosaver({
    initialContent: "initial",
    debounceMs: 1_000,
    persist: async (content) => {
      writes.push(content);
      return undefined;
    },
    onState: () => undefined,
  });

  saver.change("before-dispose");
  await saver.dispose();
  saver.change("after-dispose");
  await saver.flush();

  assert.deepEqual(writes, ["before-dispose"]);
});

test("activate makes an autosaver reusable after a development lifecycle cleanup", async () => {
  const writes: string[] = [];
  const saver = new FileAutosaver({
    initialContent: "initial",
    debounceMs: 1_000,
    persist: async (content) => {
      writes.push(content);
      return undefined;
    },
    onState: () => undefined,
  });

  saver.change("first");
  await saver.dispose();
  saver.activate();
  saver.change("second");
  await saver.flush();

  assert.deepEqual(writes, ["first", "second"]);
  assert.equal(saver.state.status, "saved");
});

test("cancel drops queued writes and prevents a follow-up write", async () => {
  const calls: string[] = [];
  const firstWrite = deferred<void>();
  const saver = new FileAutosaver({
    initialContent: "initial",
    debounceMs: 1_000,
    persist: (content) => {
      calls.push(content);
      return firstWrite.promise;
    },
    onState: () => undefined,
  });

  saver.change("one");
  const flush = saver.flush();
  await waitFor(() => calls.length === 1);
  saver.change("two");
  saver.cancel();
  firstWrite.resolve();
  await flush;
  await saver.dispose();

  assert.deepEqual(calls, ["one"]);

  const cancelledBeforeWrite: string[] = [];
  const cancelled = new FileAutosaver({
    debounceMs: 10,
    persist: async (content) => {
      cancelledBeforeWrite.push(content);
      return undefined;
    },
    onState: () => undefined,
  });
  cancelled.change("never-written");
  cancelled.cancel();
  await delay(25);
  await cancelled.flush();
  assert.deepEqual(cancelledBeforeWrite, []);
});
