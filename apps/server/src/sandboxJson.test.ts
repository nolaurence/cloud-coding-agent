import assert from "node:assert/strict";
import { Writable } from "node:stream";
import test from "node:test";
import { parseJsonFromBuffer, parseJsonUtf8, writeJsonToStream } from "./sandboxJson.js";

async function encode(value: unknown, chunkSize = 16): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  await writeJsonToStream(stream, value, chunkSize);
  return Buffer.concat(chunks);
}

test("streamed JSON matches JSON.stringify without building one payload string", async () => {
  const payload = {
    action: "run",
    files: {
      "src/a.ts": { data: "A".repeat(100), executable: false },
      "bin/data": { data: Buffer.from([0, 255, 1]).toString("base64"), executable: true },
    },
    deleted: ["gone.txt"],
    nested: { ok: true, count: 3, missing: undefined },
    unicode: "你好\n\t\"\\",
  };
  const encoded = await encode(payload);
  assert.ok(encoded.length > 16, "payload should be flushed in multiple chunks");
  assert.deepEqual(JSON.parse(encoded.toString("utf8")), JSON.parse(JSON.stringify(payload)));
});

test("buffer parser reads the same values as JSON.parse, including when the safe-string path is skipped", () => {
  const payload = {
    result: {
      stdout: "ok",
      files: { "app.ts": { data: "YWJj", executable: false } },
      deleted: [] as string[],
      exitCode: 0,
      nested: [1, true, null, { "你好": "世界" }],
    },
  };
  const buf = Buffer.from(JSON.stringify(payload), "utf8");
  assert.deepEqual(parseJsonFromBuffer(buf), JSON.parse(buf.toString("utf8")));
  assert.deepEqual(parseJsonUtf8(buf, 8), JSON.parse(buf.toString("utf8")));
});

test("stream writer never concatenates a whole snapshot into one JSON.stringify call", async () => {
  const files: Record<string, { data: string; executable: boolean }> = Object.create(null);
  for (let index = 0; index < 50; index++) {
    files[`file-${index}.txt`] = { data: "x".repeat(1000), executable: false };
  }
  const snapshot = { action: "run", code: "return 1;", timeout_ms: 1000, files };
  const original = JSON.stringify;
  let stringifiedRoot = false;
  JSON.stringify = ((value: unknown, ...rest: unknown[]) => {
    if (value === snapshot) stringifiedRoot = true;
    return (original as (...args: unknown[]) => string)(value, ...rest);
  }) as typeof JSON.stringify;
  try {
    const encoded = await encode(snapshot, 1024);
    assert.equal(stringifiedRoot, false);
    assert.deepEqual(JSON.parse(encoded.toString("utf8")), JSON.parse(original(snapshot)));
  } finally {
    JSON.stringify = original;
  }
});
