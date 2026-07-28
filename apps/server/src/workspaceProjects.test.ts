import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { store } from "./store.js";
import { createUserWorkspace, normalizeWorkspaceName } from "./workspaceProjects.js";

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-workspace-projects-"));
  const previousProjects = store.projects;
  const previousAddProject = store.addProject;
  store.projects = [];
  t.after(() => {
    store.projects = previousProjects;
    store.addProject = previousAddProject;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("normalizes and validates workspace display names", () => {
  assert.equal(normalizeWorkspaceName("  我的工作区  "), "我的工作区");
  assert.throws(() => normalizeWorkspaceName("   "), /请输入工作区名称/);
  assert.throws(() => normalizeWorkspaceName("a".repeat(81)), /不能超过 80 个字符/);
  assert.throws(() => normalizeWorkspaceName("bad\u0000name"), /控制字符/);
});

test("creates an owned UUID directory instead of using the display name", async (t) => {
  const root = fixture(t);
  store.addProject = async (project) => { store.projects.push(project); };

  const project = await createUserWorkspace(" user-one ", " Product API ", root);

  assert.equal(project.name, "Product API");
  assert.equal(project.ownerId, "user-one");
  assert.match(project.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  assert.equal(project.path, path.join(fs.realpathSync(root), project.id));
  assert.equal(fs.statSync(project.path).isDirectory(), true);
  assert.notEqual(path.basename(project.path), project.name);
  assert.deepEqual(store.projects, [project]);
});

test("removes the new directory when project persistence fails", async (t) => {
  const root = fixture(t);
  store.addProject = async () => { throw new Error("database unavailable"); };

  await assert.rejects(createUserWorkspace("user-one", "Workspace", root), /database unavailable/);
  assert.deepEqual(fs.readdirSync(root), []);
  assert.deepEqual(store.projects, []);
});
