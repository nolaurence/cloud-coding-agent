/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";
import {
  appendBrowsePath,
  canNavigateUp,
  getBrowseDirectoryPath,
  getBrowseLeaf,
  getBrowseParentPath,
  isBrowseDirectoryPath,
} from "./directoryPaths.js";

test("directory path helpers preserve home, Unix, and Windows path styles", () => {
  assert.equal(getBrowseDirectoryPath("~/Pro"), "~/");
  assert.equal(getBrowseLeaf("~/Pro"), "Pro");
  assert.equal(appendBrowsePath("~/Pro", "Projects"), "~/Projects/");
  assert.equal(getBrowseParentPath("~/Projects/src/"), "~/Projects/");

  assert.equal(getBrowseDirectoryPath("F:\\pro"), "F:\\");
  assert.equal(appendBrowsePath("F:\\pro", "projects"), "F:\\projects\\");
  assert.equal(getBrowseParentPath("F:\\projects\\cloud\\"), "F:\\projects\\");

  assert.equal(getBrowseParentPath("/workspace/project/"), "/workspace/");
  assert.equal(getBrowseParentPath("/"), null);
});

test("directory path helpers expose navigation only below a root", () => {
  assert.equal(canNavigateUp("~/"), false);
  assert.equal(canNavigateUp("~/Projects/"), true);
  assert.equal(canNavigateUp("F:\\"), false);
  assert.equal(canNavigateUp("F:\\projects\\"), true);
  assert.equal(isBrowseDirectoryPath("F:\\"), true);
  assert.equal(isBrowseDirectoryPath("relative/path"), false);
});
