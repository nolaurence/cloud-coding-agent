import assert from "node:assert/strict";
import test from "node:test";
import type { ThreadMeta, Workspace } from "@cca/protocol";
import {
  archivedDaysRemaining,
  groupArchivedThreads,
  SIDEBAR_THREAD_LIMIT,
  sortSidebarThreads,
  visibleSidebarThreads,
} from "./threadGroups.js";

const project: Workspace = { id: "project-1", name: "项目一" };
const otherProject: Workspace = { id: "project-2", name: "项目二" };

function thread(overrides: Partial<ThreadMeta> & Pick<ThreadMeta, "id">): ThreadMeta {
  const { id, ...rest } = overrides;
  return {
    id,
    projectId: "project-1",
    title: id,
    createdAt: 1,
    updatedAt: 1,
    archived: false,
    ...rest,
  };
}

test("sidebar sorting puts pinned threads first and keeps pin time order", () => {
  const sorted = sortSidebarThreads([
    thread({ id: "recent", updatedAt: 500 }),
    thread({ id: "old-pin", pinnedAt: 100, updatedAt: 100 }),
    thread({ id: "new-pin", pinnedAt: 300, updatedAt: 50 }),
    thread({ id: "older", updatedAt: 200 }),
  ]);

  assert.deepEqual(sorted.map((item) => item.id), ["new-pin", "old-pin", "recent", "older"]);
});

test("sidebar shows at most six threads until expanded", () => {
  const threads = Array.from({ length: 8 }, (_, index) =>
    thread({ id: `thread-${index}`, updatedAt: 1000 - index }),
  );

  const collapsed = visibleSidebarThreads(threads, false);
  assert.equal(collapsed.visible.length, SIDEBAR_THREAD_LIMIT);
  assert.equal(collapsed.hiddenCount, 2);

  const expanded = visibleSidebarThreads(threads, true);
  assert.equal(expanded.visible.length, 8);
  assert.equal(expanded.hiddenCount, 0);
});

test("archived groups ignore active and unknown workspaces and sort by archive time", () => {
  const groups = groupArchivedThreads(
    [
      thread({ id: "active" }),
      thread({ id: "unknown", projectId: "missing", archived: true, archivedAt: 900 }),
      thread({ id: "one-old", archived: true, archivedAt: 100 }),
      thread({ id: "one-new", archived: true, archivedAt: 200 }),
      thread({ id: "two", projectId: "project-2", archived: true, archivedAt: 300 }),
    ],
    [project, otherProject],
  );

  assert.deepEqual(groups.map((group) => group.project.id), ["project-2", "project-1"]);
  assert.deepEqual(groups[1]!.threads.map((item) => item.id), ["one-new", "one-old"]);
});

test("archived retention reports remaining days from the archive timestamp", () => {
  const now = 1_000_000;
  const archived = thread({
    id: "archived",
    archived: true,
    archivedAt: now - 10 * 24 * 60 * 60 * 1000,
  });

  assert.equal(archivedDaysRemaining(archived, now), 20);
  assert.equal(archivedDaysRemaining(thread({ id: "legacy", archived: true }), now), null);
  assert.equal(
    archivedDaysRemaining(
      thread({ id: "expired", archived: true, archivedAt: now - 31 * 24 * 60 * 60 * 1000 }),
      now,
    ),
    0,
  );
});
