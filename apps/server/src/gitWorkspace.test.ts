import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import {
  parseProjectGitStatus,
  projectGitCommitDiff,
  projectGitFileDiff,
  projectGitLog,
  projectGitPushTarget,
  projectGitStagedDiff,
  projectGitStatus,
  stageProjectFiles,
  unstageProjectFiles,
  withProjectGitMutation,
} from "./gitWorkspace.js";

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  return result.stdout;
}

async function createRepository(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-git-workspace-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Test User"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  return root;
}

async function commitAll(root: string, message: string): Promise<void> {
  await git(root, ["add", "--all"]);
  await git(root, ["commit", "-m", message]);
}

test("parses copy records and ahead/behind metadata from porcelain v2", () => {
  const hash = "a".repeat(40);
  const output = [
    "# branch.oid " + hash,
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -3",
    `2 C. N... 100644 100644 100644 ${hash} ${hash} C100 copy.txt`,
    "source.txt",
    "",
  ].join("\0");
  const status = parseProjectGitStatus(output, hash, hash);
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 3);
  assert.deepEqual(status.files, [
    { path: "copy.txt", oldPath: "source.txt", staged: "C" },
  ]);
});

test("reads branch metadata and combines staged rename with unstaged changes", async (t) => {
  const root = await createRepository(t);
  await fs.writeFile(path.join(root, "old.txt"), "one\n");
  await commitAll(root, "initial");
  await git(root, ["remote", "add", "origin", "https://github.com/acme/example.git"]);
  await git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  await git(root, ["config", "branch.main.remote", "origin"]);
  await git(root, ["config", "branch.main.merge", "refs/heads/main"]);

  await fs.writeFile(path.join(root, "second.txt"), "second\n");
  await commitAll(root, "ahead commit");
  await git(root, ["mv", "old.txt", "renamed.txt"]);
  await fs.appendFile(path.join(root, "renamed.txt"), "working tree\n");
  await fs.writeFile(path.join(root, "untracked.txt"), "new\n");

  const status = await projectGitStatus(root);
  assert.equal(status.branch, "main");
  assert.equal(status.detached, false);
  assert.equal(status.upstream, "origin/main");
  assert.equal(status.ahead, 1);
  assert.equal(status.behind, 0);
  assert.match(status.head ?? "", /^[a-f0-9]{40,64}$/);
  assert.match(status.indexTree, /^[a-f0-9]{40,64}$/);
  assert.deepEqual(
    status.files.find((file) => file.path === "renamed.txt"),
    { path: "renamed.txt", oldPath: "old.txt", staged: "R", unstaged: "M" },
  );
  assert.deepEqual(status.files.find((file) => file.path === "untracked.txt"), {
    path: "untracked.txt",
    unstaged: "?",
  });
});

test("reads paged and searched commit logs", async (t) => {
  const root = await createRepository(t);
  for (const [index, subject] of ["first", "needle change", "latest"].entries()) {
    await fs.writeFile(path.join(root, "value.txt"), `${index}\n`);
    await commitAll(root, subject);
  }

  const page = await projectGitLog(root, { limit: 2 });
  assert.equal(page.hasMore, true);
  assert.deepEqual(page.commits.map((commit) => commit.subject), ["latest", "needle change"]);
  assert.equal(page.commits[0]?.author, "Test User");
  assert.equal(page.commits[0]?.email, "test@example.com");
  assert.ok((page.commits[0]?.date ?? 0) > 1_000_000_000_000);

  const search = await projectGitLog(root, { query: "NEEDLE" });
  assert.deepEqual(search.commits.map((commit) => commit.subject), ["needle change"]);
  assert.equal(search.hasMore, false);
  await assert.rejects(projectGitLog(root, { limit: 0 }), /1 到 200/);
  await assert.rejects(projectGitLog(root, { query: "x".repeat(201) }), /不能超过 200/);
});

test("returns an empty log for an unborn repository", async (t) => {
  const root = await createRepository(t);
  assert.deepEqual(await projectGitLog(root), { commits: [], hasMore: false });
  const status = await projectGitStatus(root);
  assert.equal(status.head, null);
  assert.ok(status.indexTree);
});

test("renders normal and root commit diffs and validates commit hashes", async (t) => {
  const root = await createRepository(t);
  await fs.writeFile(path.join(root, "first.txt"), "first\n");
  await commitAll(root, "initial");
  const rootHash = (await git(root, ["rev-parse", "HEAD"])).trim();

  await fs.appendFile(path.join(root, "first.txt"), "second\n");
  await fs.writeFile(path.join(root, "added.txt"), "added\n");
  await commitAll(root, "next");
  const nextHash = (await git(root, ["rev-parse", "HEAD"])).trim();

  const initial = await projectGitCommitDiff(root, rootHash);
  assert.equal(initial.hash, rootHash);
  assert.match(initial.patch, /new file mode/);
  assert.match(initial.patch, /^\+first$/m);

  const next = await projectGitCommitDiff(root, nextHash);
  assert.match(next.patch, /diff --git a\/added\.txt b\/added\.txt/);
  assert.match(next.patch, /^\+second$/m);
  assert.equal(next.truncated, false);

  await assert.rejects(projectGitCommitDiff(root, "HEAD"), /提交哈希无效/);
  await assert.rejects(projectGitCommitDiff(root, `${nextHash}^`), /提交哈希无效/);
});

test("renders tracked and untracked file diffs with staged selection", async (t) => {
  const root = await createRepository(t);
  await fs.writeFile(path.join(root, "tracked.txt"), "one\n");
  await commitAll(root, "initial");
  await fs.writeFile(path.join(root, "tracked.txt"), "one\ntwo\n");

  const unstaged = await projectGitFileDiff(root, "tracked.txt", false);
  assert.match(unstaged.patch, /^diff --git/m);
  assert.match(unstaged.patch, /^\+two$/m);
  assert.equal(unstaged.truncated, false);

  const beforeStage = await projectGitStatus(root);
  await stageProjectFiles(root, ["tracked.txt"], {
    expectedHead: beforeStage.head,
    expectedIndexTree: beforeStage.indexTree,
  });

  const staged = await projectGitFileDiff(root, "tracked.txt", true);
  assert.match(staged.patch, /^\+two$/m);

  await fs.writeFile(path.join(root, "new file.txt"), "alpha\nbeta");
  const untracked = await projectGitFileDiff(root, "new file.txt", false);
  assert.match(untracked.patch, /new file mode/);
  assert.match(untracked.patch, /^\+alpha$/m);
  assert.match(untracked.patch, /^\+beta$/m);
});

test("reads only staged changes for commit message generation", async (t) => {
  const root = await createRepository(t);
  await fs.writeFile(path.join(root, "tracked.txt"), "one\n");
  await commitAll(root, "initial");
  await fs.writeFile(path.join(root, "tracked.txt"), "one\nstaged\n");
  await git(root, ["add", "tracked.txt"]);
  await fs.appendFile(path.join(root, "tracked.txt"), "unstaged\n");

  const result = await projectGitStagedDiff(root);
  assert.match(result.patch, /^\+staged$/m);
  assert.doesNotMatch(result.patch, /^\+unstaged$/m);
  assert.equal(result.truncated, false);

  await git(root, ["reset", "--quiet", "HEAD", "--", "tracked.txt"]);
  await assert.rejects(projectGitStagedDiff(root), /没有已暂存/);
});

test("caps staged diffs used for commit message generation", async (t) => {
  const root = await createRepository(t);
  await fs.writeFile(path.join(root, "large.txt"), "small\n");
  await commitAll(root, "initial");
  await fs.writeFile(path.join(root, "large.txt"), `${"x".repeat(512 * 1024)}\n`);
  await git(root, ["add", "large.txt"]);

  const result = await projectGitStagedDiff(root);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.patch, "utf8") <= 256 * 1024);
});

test("caps oversized file diffs at two megabytes", async (t) => {
  const root = await createRepository(t);
  await fs.writeFile(path.join(root, "large.txt"), "small\n");
  await commitAll(root, "initial");
  await fs.writeFile(path.join(root, "large.txt"), `${"x".repeat(3 * 1024 * 1024)}\n`);

  const result = await projectGitFileDiff(root, "large.txt", false);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.patch, "utf8") <= 2 * 1024 * 1024);
});

test("stages and unstages selected rename paths and rejects stale versions", async (t) => {
  const root = await createRepository(t);
  await fs.writeFile(path.join(root, "old.txt"), "old\n");
  await fs.writeFile(path.join(root, "other.txt"), "other\n");
  await commitAll(root, "initial");
  await git(root, ["mv", "old.txt", "new.txt"]);

  const renamed = await projectGitStatus(root);
  assert.equal(renamed.files.find((file) => file.path === "new.txt")?.staged, "R");
  await unstageProjectFiles(root, ["new.txt"], {
    expectedHead: renamed.head,
    expectedIndexTree: renamed.indexTree,
  });
  assert.equal((await projectGitStatus(root)).files.some((file) => file.staged), false);

  const stale = await projectGitStatus(root);
  await fs.appendFile(path.join(root, "other.txt"), "changed\n");
  await git(root, ["add", "other.txt"]);
  await assert.rejects(
    stageProjectFiles(root, ["new.txt"], {
      expectedHead: stale.head,
      expectedIndexTree: stale.indexTree,
    }),
    /已发生变化/,
  );
  await assert.rejects(stageProjectFiles(root, []), /1 到 200/);
  await assert.rejects(stageProjectFiles(root, ["../outside.txt"]), /相对路径/);
});

test("selects current branch and upstream remote for pushes", async (t) => {
  const root = await createRepository(t);
  await fs.writeFile(path.join(root, "file.txt"), "one\n");
  await commitAll(root, "initial");

  assert.deepEqual(await projectGitPushTarget(root), {
    remote: "origin",
    branch: "main",
    setUpstream: true,
  });
  await git(root, ["remote", "add", "team", "https://github.com/acme/example.git"]);
  await git(root, ["update-ref", "refs/remotes/team/main", "HEAD"]);
  await git(root, ["config", "branch.main.remote", "team"]);
  await git(root, ["config", "branch.main.merge", "refs/heads/main"]);
  assert.deepEqual(await projectGitPushTarget(root), {
    remote: "team",
    branch: "main",
    setUpstream: false,
  });

  await git(root, ["checkout", "--detach", "HEAD"]);
  await assert.rejects(projectGitPushTarget(root), /detached HEAD/);
});

test("serializes Git mutations for the same project", async (t) => {
  const root = await createRepository(t);
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const first = withProjectGitMutation(root, async () => {
    events.push("first:start");
    await firstGate;
    events.push("first:end");
  });
  const second = withProjectGitMutation(root, async () => {
    events.push("second:start");
    events.push("second:end");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});
