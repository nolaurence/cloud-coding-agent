import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Workspace } from "@cca/protocol";
import { useApp } from "./store.js";
import {
  loadWorkspaceOrder,
  moveSidebarWorkspace,
  saveWorkspaceOrder,
  sortSidebarWorkspaces,
} from "./workspaceOrder.js";

const workspaces: Workspace[] = [
  { id: "one", name: "工作区一" },
  { id: "two", name: "工作区二" },
  { id: "three", name: "工作区三" },
  { id: "four", name: "工作区四" },
];

const ids = (projects: readonly Workspace[]) => projects.map((project) => project.id);

function fixture(context: TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const state = useApp.getState();
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  context.after(() => {
    useApp.setState(state);
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  return { values, storage };
}

test("workspaces keep server order until the user chooses an order", () => {
  assert.deepEqual(ids(sortSidebarWorkspaces(workspaces, [])), ["one", "two", "three", "four"]);
});

test("saved workspace order ignores removed IDs and appends new workspaces in server order", () => {
  const sorted = sortSidebarWorkspaces(workspaces, ["three", "missing", "one", "three"]);

  assert.deepEqual(ids(sorted), ["three", "one", "two", "four"]);
  assert.deepEqual(ids(workspaces), ["one", "two", "three", "four"]);
});

test("workspaces move above and below another workspace without mutating the original", () => {
  assert.deepEqual(ids(moveSidebarWorkspace(workspaces, "four", "two", "before")), [
    "one", "four", "two", "three",
  ]);
  assert.deepEqual(ids(moveSidebarWorkspace(workspaces, "one", "three", "after")), [
    "two", "three", "one", "four",
  ]);
  assert.deepEqual(ids(moveSidebarWorkspace(workspaces, "one", "three", "before")), [
    "two", "one", "three", "four",
  ]);
  assert.deepEqual(ids(moveSidebarWorkspace(workspaces, "four", "two", "after")), [
    "one", "two", "four", "three",
  ]);
  assert.deepEqual(ids(workspaces), ["one", "two", "three", "four"]);
});

test("dropping in place, onto itself, or onto an unknown workspace does not change order", () => {
  assert.equal(moveSidebarWorkspace(workspaces, "one", "two", "before"), workspaces);
  assert.equal(moveSidebarWorkspace(workspaces, "two", "one", "after"), workspaces);
  assert.equal(moveSidebarWorkspace(workspaces, "one", "one", "after"), workspaces);
  assert.equal(moveSidebarWorkspace(workspaces, "missing", "one", "before"), workspaces);
  assert.equal(moveSidebarWorkspace(workspaces, "one", "missing", "after"), workspaces);
});

test("workspace order persists separately for each account", (context) => {
  fixture(context);
  saveWorkspaceOrder("用户一", ["three", "one"]);
  saveWorkspaceOrder("用户二", ["one", "three"]);

  assert.deepEqual(loadWorkspaceOrder("用户一"), ["three", "one"]);
  assert.deepEqual(loadWorkspaceOrder("用户二"), ["one", "three"]);
  assert.deepEqual(loadWorkspaceOrder("新用户"), []);
});

test("workspace order tolerates corrupt storage and filters invalid or duplicate IDs", (context) => {
  const { values } = fixture(context);
  const key = "cloud-coding-agent:workspace-order:user";
  for (const value of ["invalid json", "null", "{}", "42", '"one"']) {
    values.set(key, value);
    assert.deepEqual(loadWorkspaceOrder("user"), []);
  }
  values.set(key, JSON.stringify(["three", 1, null, "", "one", "three", {}]));
  assert.deepEqual(loadWorkspaceOrder("user"), ["three", "one"]);
});

test("unavailable browser storage does not prevent workspace ordering", (context) => {
  const { storage } = fixture(context);
  context.mock.method(storage, "getItem", () => { throw new Error("Storage disabled"); });
  context.mock.method(storage, "setItem", () => { throw new Error("Storage disabled"); });

  assert.deepEqual(loadWorkspaceOrder("user"), []);
  assert.doesNotThrow(() => saveWorkspaceOrder("user", ["one"]));
  useApp.setState({ user: { username: "user", role: "admin" }, projects: workspaces, workspaceOrder: [] });
  useApp.getState().reorderWorkspaces("four", "one", "before");
  assert.deepEqual(useApp.getState().workspaceOrder, ["four", "one", "two", "three"]);
});

test("store keeps workspace order through server refreshes and restores it from storage", (context) => {
  fixture(context);
  useApp.setState({ user: { username: "user", role: "admin" }, projects: workspaces, workspaceOrder: [] });
  useApp.getState().reorderWorkspaces("four", "two", "before");

  assert.deepEqual(useApp.getState().workspaceOrder, ["one", "four", "two", "three"]);
  assert.deepEqual(loadWorkspaceOrder("user"), ["one", "four", "two", "three"]);
  assert.equal(useApp.getState().projects, workspaces);

  useApp.setState({ projects: [...workspaces].reverse() });
  const refreshed = useApp.getState();
  assert.deepEqual(ids(sortSidebarWorkspaces(refreshed.projects, refreshed.workspaceOrder)), [
    "one", "four", "two", "three",
  ]);

  useApp.setState({ workspaceOrder: [] });
  useApp.setState({ workspaceOrder: loadWorkspaceOrder("user") });
  assert.deepEqual(useApp.getState().workspaceOrder, ["one", "four", "two", "three"]);
});

test("store does not save invalid moves or moves while logged out", (context) => {
  const { values } = fixture(context);
  useApp.setState({ user: { username: "user", role: "admin" }, projects: workspaces, workspaceOrder: [] });
  useApp.getState().reorderWorkspaces("one", "missing", "after");
  useApp.getState().reorderWorkspaces("one", "two", "before");
  assert.deepEqual(useApp.getState().workspaceOrder, []);
  assert.equal(values.size, 0);

  useApp.setState({ user: null });
  useApp.getState().reorderWorkspaces("four", "one", "before");
  assert.deepEqual(useApp.getState().workspaceOrder, []);
  assert.equal(values.size, 0);
});
