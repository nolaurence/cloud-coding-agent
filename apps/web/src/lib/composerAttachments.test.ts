import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import React from "react";
import { renderToString } from "react-dom/server";
import { connect, disconnect } from "./client.js";
import { useComposerAttachments } from "./composerAttachments.js";

type Composer = ReturnType<typeof useComposerAttachments>;

function captureComposer(draftKey: string): Composer {
  let composer: Composer | undefined;
  function Capture() {
    composer = useComposerAttachments(draftKey);
    return null;
  }
  renderToString(React.createElement(Capture));
  assert.ok(composer);
  return composer;
}

function fixture(t: TestContext) {
  const globals = ["WebSocket", "location"] as const;
  const descriptors = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: class {
      static OPEN = 1;
      readyState = 1;
      close() {}
    },
  });
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "https:", host: "attachments.test" },
  });
  t.after(() => {
    disconnect();
    globals.forEach((key, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    });
  });
  connect("attachment-test-token");

  // Zustand's SSR snapshot is the initial state. Read the live snapshot while
  // still calling the real React hook and rendering the real composer API.
  const useSyncExternalStore = React.useSyncExternalStore;
  t.mock.method(React, "useSyncExternalStore", <T>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => T,
  ) => useSyncExternalStore(subscribe, getSnapshot, getSnapshot));

  let nextPreview = 0;
  const revoked: string[] = [];
  t.mock.method(URL, "createObjectURL", () => `blob:attachment-test/${++nextPreview}`);
  t.mock.method(URL, "revokeObjectURL", (url: string) => { revoked.push(url); });

  const requests: { url: string; init: RequestInit }[] = [];
  const uploads: { resolve: (response: Response) => void }[] = [];
  t.mock.method(globalThis, "fetch", (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, init });
    if (init.method === "DELETE") return Promise.resolve(new Response(null, { status: 204 }));
    return new Promise<Response>((resolve) => { uploads.push({ resolve }); });
  });

  return {
    composer: (key = "current") => captureComposer(`${t.name}:${key}`),
    requests,
    uploads,
    revoked,
    deleted: () => requests.filter(({ init }) => init.method === "DELETE").map(({ url }) => url),
    async respond(index: number, body: object, status = 200) {
      const upload = uploads[index];
      assert.ok(upload, `upload ${index} must already have started`);
      upload.resolve(Response.json(body, { status }));
      await setImmediate();
    },
    async succeed(index: number, id: string) {
      await this.respond(index, { id, path: `/uploads/${id}` });
    },
  };
}

function image(name = "photo.png") {
  return new File(["image bytes"], name, { type: "image/png" });
}

function document(name = "notes.txt") {
  return new File(["document bytes"], name, { type: "text/plain" });
}

test("selecting attachments starts image and file uploads immediately", async (t) => {
  const f = fixture(t);
  const photo = image();
  const notes = document();

  assert.equal(f.composer().addFiles([photo, notes]), "");

  assert.equal(f.uploads.length, 2);
  assert.deepEqual(f.requests.map(({ url }) => url), ["/api/uploads/images", "/api/uploads/files"]);
  assert.deepEqual(f.requests.map(({ init }) => init.body), [photo, notes]);
  assert.equal(new Headers(f.requests[0]!.init.headers).get("Authorization"), "Bearer attachment-test-token");
  assert.deepEqual(f.composer().attachments.map(({ status }) => status), ["uploading", "uploading"]);

  await f.succeed(1, "document-id");
  assert.deepEqual(f.composer().attachments.map(({ status }) => status), ["uploading", "ready"]);
  await f.succeed(0, "image-id");

  assert.deepEqual(f.composer().attachments.map(({ uploaded }) => uploaded), [
    { imageId: "image-id", path: "/uploads/image-id", displayName: photo.name },
    { fileId: "document-id", path: "/uploads/document-id", displayName: notes.name },
  ]);
  assert.deepEqual(f.deleted(), []);
});

test("drafts keep their own attachments when uploads finish after switching contexts", async (t) => {
  const f = fixture(t);
  f.composer("new-chat").addFiles([document("new.txt")]);
  f.composer("thread-one").addFiles([document("one.txt")]);
  f.composer("thread-two").addFiles([document("two.txt")]);

  await f.succeed(2, "two");
  await f.succeed(0, "new");
  await f.succeed(1, "one");

  assert.equal(f.composer("new-chat").attachments[0]?.file.name, "new.txt");
  assert.equal(f.composer("thread-one").attachments[0]?.uploaded?.fileId, "one");
  assert.equal(f.composer("thread-two").attachments[0]?.uploaded?.fileId, "two");
  const first = f.composer("thread-one").attachments[0]!;
  f.composer("thread-one").removeAttachment(first.id);

  assert.deepEqual(f.composer("thread-one").attachments, []);
  assert.equal(f.composer("new-chat").attachments[0]?.uploaded?.fileId, "new");
  assert.equal(f.composer("thread-two").attachments[0]?.uploaded?.fileId, "two");
  assert.deepEqual(f.deleted(), ["/api/uploads/files/one"]);
});

test("removing an uploading attachment deletes its late response without restoring it", async (t) => {
  const f = fixture(t);
  f.composer().addFiles([image()]);
  const selected = f.composer().attachments[0]!;

  f.composer().removeAttachment(selected.id);

  assert.deepEqual(f.composer().attachments, []);
  assert.deepEqual(f.revoked, [selected.previewUrl]);
  assert.deepEqual(f.deleted(), []);

  await f.succeed(0, "removed/image");

  assert.deepEqual(f.composer().attachments, []);
  assert.deepEqual(f.deleted(), ["/api/uploads/images/removed%2Fimage"]);
});

test("a failed upload preserves the file and can be retried", async (t) => {
  const f = fixture(t);
  const file = document();
  f.composer().addFiles([file]);
  const id = f.composer().attachments[0]!.id;

  await f.respond(0, { error: "upload temporarily unavailable" }, 503);

  const failed = f.composer().attachments[0]!;
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "upload temporarily unavailable");
  assert.equal(failed.file, file);
  assert.equal(failed.uploaded, undefined);

  f.composer().retryAttachment(id);

  assert.equal(f.uploads.length, 2);
  assert.equal(f.requests[1]?.init.body, file);
  assert.equal(f.composer().attachments[0]?.status, "uploading");
  assert.equal(f.composer().attachments[0]?.error, undefined);

  await f.succeed(1, "retried");

  assert.equal(f.composer().attachments[0]?.id, id);
  assert.equal(f.composer().attachments[0]?.status, "ready");
  assert.equal(f.composer().attachments[0]?.uploaded?.fileId, "retried");
  assert.deepEqual(f.deleted(), []);
});

test("a successful send clears only its snapshot and never deletes sent uploads", async (t) => {
  const f = fixture(t);
  f.composer().addFiles([image()]);
  await f.succeed(0, "sent");
  const sent = f.composer().attachments;

  f.composer().addFiles([document("added-while-sending.txt")]);
  f.composer("other-draft").addFiles([document("other.txt")]);
  const later = f.composer().attachments[1]!;
  const other = f.composer("other-draft").attachments;

  f.composer().clearSentAttachments(sent);

  assert.deepEqual(f.composer().attachments, [later]);
  assert.deepEqual(f.composer("other-draft").attachments, other);
  assert.deepEqual(f.revoked, [sent[0]!.previewUrl]);
  assert.deepEqual(f.deleted(), []);

  await f.succeed(1, "later");
  await f.succeed(2, "other");

  assert.equal(f.composer().attachments[0]?.uploaded?.fileId, "later");
  assert.equal(f.composer("other-draft").attachments[0]?.uploaded?.fileId, "other");
  assert.deepEqual(f.deleted(), []);
});

test("a failed send invalidates only sent uploads and allows uploading them again", async (t) => {
  const f = fixture(t);
  const file = document("sent.txt");
  f.composer().addFiles([file]);
  await f.succeed(0, "failed-send");
  const sent = f.composer().attachments;
  f.composer().addFiles([document("new.txt")]);
  const later = f.composer().attachments[1]!;

  f.composer().invalidateAttachments(sent);

  const invalidated = f.composer().attachments[0]!;
  assert.equal(invalidated.id, sent[0]!.id);
  assert.equal(invalidated.file, file);
  assert.equal(invalidated.status, "error");
  assert.equal(invalidated.uploaded, undefined);
  assert.ok(invalidated.error);
  assert.equal(f.composer().attachments[1], later);
  assert.deepEqual(f.deleted(), ["/api/uploads/files/failed-send"]);

  f.composer().retryAttachment(invalidated.id);

  assert.equal(f.uploads.length, 3);
  assert.equal(f.requests[3]?.init.body, file);
  assert.equal(f.composer().attachments[0]?.status, "uploading");
  await f.succeed(2, "resent");
  await f.succeed(1, "new");

  assert.equal(f.composer().attachments[0]?.id, sent[0]!.id);
  assert.equal(f.composer().attachments[0]?.status, "ready");
  assert.equal(f.composer().attachments[0]?.uploaded?.fileId, "resent");
  assert.equal(f.composer().attachments[1]?.uploaded?.fileId, "new");
  assert.deepEqual(f.deleted(), ["/api/uploads/files/failed-send"]);
});
