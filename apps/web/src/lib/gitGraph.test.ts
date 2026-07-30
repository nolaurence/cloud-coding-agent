import assert from "node:assert/strict";
import test from "node:test";
import type { GitLogCommit } from "@cca/protocol";
import { layoutGitGraph } from "./gitGraph.js";

function commit(hash: string, parents: string[]): GitLogCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    author: "Test",
    email: "test@example.com",
    date: 0,
    subject: hash,
    refs: [],
  };
}

test("lays out a linear history in one lane", () => {
  const rows = layoutGitGraph([
    commit("ccccccc", ["bbbbbbb"]),
    commit("bbbbbbb", ["aaaaaaa"]),
    commit("aaaaaaa", []),
  ]);

  assert.deepEqual(rows.map((row) => row.lane), [0, 0, 0]);
  assert.deepEqual(rows.map((row) => row.parentLanes), [[0], [0], []]);
});

test("reserves and collapses lanes for a merge", () => {
  const rows = layoutGitGraph([
    commit("merge00", ["main000", "side000"]),
    commit("main000", ["base000"]),
    commit("side000", ["base000"]),
    commit("base000", []),
  ]);

  assert.deepEqual(rows.map((row) => row.lane), [0, 0, 1, 0]);
  assert.deepEqual(rows[0]?.parentLanes, [0, 1]);
  assert.ok(rows[2]?.activeLanes.includes(1));
});
