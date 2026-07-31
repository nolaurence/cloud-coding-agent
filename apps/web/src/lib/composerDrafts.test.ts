import assert from "node:assert/strict";
import test from "node:test";
import {
  clearComposerDraft,
  NEW_CHAT_DRAFT_KEY,
  threadComposerDraftKey,
  updateComposerDraft,
} from "./composerDrafts.js";

test("composer draft keys isolate new chat and individual threads", () => {
  const firstThread = threadComposerDraftKey("thread-1");
  const secondThread = threadComposerDraftKey("thread-2");

  assert.notEqual(firstThread, secondThread);
  assert.notEqual(firstThread, NEW_CHAT_DRAFT_KEY);
  assert.notEqual(secondThread, NEW_CHAT_DRAFT_KEY);
});

test("composer drafts survive context switches without overwriting each other", () => {
  const firstThread = threadComposerDraftKey("thread-1");
  const secondThread = threadComposerDraftKey("thread-2");
  let drafts = updateComposerDraft({}, firstThread, "first thread draft");
  drafts = updateComposerDraft(drafts, NEW_CHAT_DRAFT_KEY, "new chat draft");
  drafts = updateComposerDraft(drafts, secondThread, "second thread draft");

  assert.equal(drafts[firstThread], "first thread draft");
  assert.equal(drafts[NEW_CHAT_DRAFT_KEY], "new chat draft");
  assert.equal(drafts[secondThread], "second thread draft");
});

test("clearing a sent draft preserves drafts from other contexts", () => {
  const sentThread = threadComposerDraftKey("sent");
  const pendingThread = threadComposerDraftKey("pending");
  const drafts = {
    [sentThread]: "send this",
    [pendingThread]: "keep this",
    [NEW_CHAT_DRAFT_KEY]: "keep new chat",
  };

  const next = clearComposerDraft(drafts, sentThread, "send this");

  assert.equal(next[sentThread], undefined);
  assert.equal(next[pendingThread], "keep this");
  assert.equal(next[NEW_CHAT_DRAFT_KEY], "keep new chat");
  assert.equal(drafts[sentThread], "send this");
});

test("a completed send does not clear text entered after that send started", () => {
  const thread = threadComposerDraftKey("active");
  const drafts = { [thread]: "newer text" };

  const next = clearComposerDraft(drafts, thread, "text being sent");

  assert.equal(next, drafts);
  assert.equal(next[thread], "newer text");
});
