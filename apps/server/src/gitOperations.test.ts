import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  BUNDLE_IMPORT_HINT,
  buildAuthenticatedGitEnv,
  commitProjectChanges,
  normalizeGitRemote,
  resolveGitWorkTree,
  runAuthenticatedGit,
  type GitRunner,
} from "./gitOperations.js";

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
}

async function initRepo(root: string): Promise<void> {
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "git@example.test"]);
  await git(root, ["config", "user.name", "Git"]);
}

test("commit can preserve the existing index without staging the working tree", async () => {
  const calls: string[][] = [];
  const runGit: GitRunner = async (args) => {
    calls.push(args);
    if (args[0] === "diff") return { stdout: "staged.txt\0", stderr: "" };
    if (args.includes("commit")) return { stdout: "committed", stderr: "" };
    if (args[0] === "rev-parse") return { stdout: "abc123\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };

  const result = await commitProjectChanges(
    process.cwd(),
    "selected files",
    { stageAll: false },
    { runGit, baseEnv: { PATH: process.env.PATH } },
  );

  assert.equal(result.hash, "abc123");
  assert.equal(calls.some((args) => args[0] === "add"), false);
  assert.deepEqual(calls[0], ["diff", "--cached", "--name-only", "-z"]);
});

test("normalizes GitHub and Gitee HTTPS and SSH remotes", () => {
  assert.deepEqual(normalizeGitRemote("git@github.com:acme/widgets.git"), {
    provider: "github",
    url: "https://github.com/acme/widgets.git",
    authScope: "https://github.com/",
  });
  assert.deepEqual(normalizeGitRemote("ssh://git@gitee.com/team/widgets"), {
    provider: "gitee",
    url: "https://gitee.com/team/widgets.git",
    authScope: "https://gitee.com/",
  });
  assert.equal(
    normalizeGitRemote("acme/widgets", "github").url,
    "https://github.com/acme/widgets.git",
  );
});

test("rejects untrusted Git remote hosts, protocols, and embedded credentials", () => {
  assert.throws(() => normalizeGitRemote("https://github.com.evil.test/acme/widgets"), /仅支持/);
  assert.throws(() => normalizeGitRemote("http://github.com/acme/widgets"), /仅支持 HTTPS 或 SSH/);
  assert.throws(() => normalizeGitRemote("https://token@github.com/acme/widgets"), /不能包含凭据/);
  assert.throws(() => normalizeGitRemote("acme/widgets"), /需要指定/);
});

test("builds a short-lived Git environment without exposing the raw token", () => {
  const token = "github-secret-token";
  const env = buildAuthenticatedGitEnv(
    {
      PATH: "test-path",
      GIT_TRACE: "1",
      GIT_DIR: "/",
      GIT_WORK_TREE: "/",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "unsafe.key",
      GIT_CONFIG_VALUE_0: "unsafe-value",
    },
    normalizeGitRemote("https://github.com/acme/widgets"),
    { username: "octocat", token },
  );

  assert.equal(env.PATH, "test-path");
  assert.equal(env.GIT_TRACE, undefined);
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_WORK_TREE, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_CONFIG_COUNT, "3");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraHeader");
  assert.match(env.GIT_CONFIG_VALUE_0 ?? "", /^Authorization: Basic /);
  assert.equal(env.GIT_CONFIG_KEY_1, "credential.helper");
  assert.equal(env.GIT_CONFIG_VALUE_1, "");
  assert.ok(!JSON.stringify(env).includes(token));
});

test("pull fetches with credentials and integrates without credentials", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-git-pull-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initRepo(root);
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const runGit: GitRunner = async (args, options) => {
    calls.push({ args, env: options.env });
    if (args[0] === "remote") return { stdout: "git@github.com:acme/widgets.git\n", stderr: "" };
    if (args.includes("fetch")) return { stdout: "fetched", stderr: "" };
    return { stdout: "updated", stderr: "" };
  };

  const result = await runAuthenticatedGit(
    "alice",
    root,
    { action: "pull", branch: "main", strategy: "rebase" },
    {
      runGit,
      baseEnv: { PATH: "test-path" },
      getCredential: (ownerId, provider) => {
        assert.equal(ownerId, "alice");
        assert.equal(provider, "github");
        return { username: "alice", token: "secret" };
      },
    },
  );

  assert.deepEqual(calls[1]?.args, [
    "-c",
    "url.https://github.com/acme/widgets.git.insteadOf=git@github.com:acme/widgets.git",
    "fetch",
    "origin",
    "main",
  ]);
  assert.match(calls[1]?.env.GIT_CONFIG_VALUE_0 ?? "", /^Authorization: Basic /);
  assert.deepEqual(calls[2]?.args, ["rebase", "FETCH_HEAD"]);
  assert.equal(calls[2]?.env.GIT_CONFIG_VALUE_0, undefined);
  assert.equal(result, "fetched\nupdated");
});

test("push disables hooks and redacts credentials from failures", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-git-push-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initRepo(root);
  const token = "gitee-top-secret";
  const encoded = Buffer.from(`alice:${token}`, "utf8").toString("base64");
  const calls: string[][] = [];
  const runGit: GitRunner = async (args) => {
    calls.push(args);
    if (args[0] === "remote") return { stdout: "https://gitee.com/acme/widgets.git\n", stderr: "" };
    throw Object.assign(new Error(`failed with ${token}`), {
      stderr: `remote rejected ${token} ${encoded}`,
    });
  };

  await assert.rejects(
    runAuthenticatedGit(
      "alice",
      root,
      { action: "push", branch: "main", setUpstream: true },
      {
        runGit,
        getCredential: () => ({ username: "alice", token }),
      },
    ),
    (reason: unknown) => {
      assert.ok(reason instanceof Error);
      assert.match(reason.message, /git push 失败/);
      assert.ok(!reason.message.includes(token));
      assert.ok(!reason.message.includes(encoded));
      return true;
    },
  );

  assert.ok(calls[1]?.includes("--no-verify"));
  assert.ok(!JSON.stringify(calls).includes(token));
});

test("requires a matching binding and keeps clone targets inside the project", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-git-operations-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await initRepo(root);
  let calls = 0;
  const runGit: GitRunner = async (args) => {
    calls += 1;
    if (args[0] === "remote") return { stdout: "https://github.com/acme/widgets.git\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };

  await assert.rejects(
    runAuthenticatedGit("alice", root, { action: "fetch" }, { runGit, getCredential: () => null }),
    /尚未绑定 GitHub/,
  );
  await assert.rejects(
    runAuthenticatedGit(
      "alice",
      root,
      { action: "clone", repository: "acme/widgets", provider: "github", destination: "../escape" },
      { runGit, getCredential: () => ({ username: "alice", token: "secret" }) },
    ),
    /项目目录内/,
  );
  assert.equal(calls, 1);
});

test("fetch and pull run in a nested clone instead of the empty workspace root", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-git-nested-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "widgets");
  await fs.mkdir(repo);
  await initRepo(repo);
  await git(repo, ["remote", "add", "origin", "https://github.com/acme/widgets.git"]);

  assert.equal(resolveGitWorkTree(root), repo);

  const calls: Array<{ cwd: string; args: string[] }> = [];
  const runGit: GitRunner = async (args, options) => {
    calls.push({ cwd: options.cwd, args });
    if (args[0] === "remote") return { stdout: "https://github.com/acme/widgets.git\n", stderr: "" };
    return { stdout: "ok", stderr: "" };
  };

  await runAuthenticatedGit(
    "alice",
    root,
    { action: "fetch", remote: "missing-remote" },
    {
      runGit,
      getCredential: () => ({ username: "alice", token: "secret" }),
    },
  );
  assert.equal(calls[0]?.cwd, repo);
  assert.deepEqual(calls[0]?.args, ["remote", "get-url", "missing-remote"]);
  assert.equal(calls[1]?.cwd, repo);

  await assert.rejects(
    runAuthenticatedGit("alice", root, { action: "fetch", remote: "missing-remote" }, {
      getCredential: () => ({ username: "alice", token: "secret" }),
      baseEnv: { ...process.env, GIT_DIR: "/", GIT_WORK_TREE: "/" },
    }),
    (reason: unknown) => {
      assert.ok(reason instanceof Error);
      assert.match(reason.message, /无法读取远程仓库|No such remote/);
      assert.doesNotMatch(reason.message, /not a git repository/i);
      assert.doesNotMatch(reason.message, /GIT_DISCOVERY_ACROSS_FILESYSTEM/);
      return true;
    },
  );
});

test("an empty workspace reports the project path instead of discovering from /", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-git-empty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(
    runAuthenticatedGit("alice", root, { action: "fetch" }, {
      getCredential: () => ({ username: "alice", token: "secret" }),
    }),
    (reason: unknown) => {
      assert.ok(reason instanceof Error);
      assert.match(reason.message, /当前工作区不是 Git 仓库/);
      assert.equal(reason.message.includes(root), true);
      assert.doesNotMatch(reason.message, /GIT_DISCOVERY_ACROSS_FILESYSTEM/);
      return true;
    },
  );
  await assert.rejects(
    runAuthenticatedGit("alice", root, { action: "commit", message: "x" }, {
      getCredential: () => {
        throw new Error("commit must not read credentials");
      },
    }),
    (reason: unknown) => {
      assert.ok(reason instanceof Error);
      assert.match(reason.message, /当前工作区不是 Git 仓库/);
      assert.equal(reason.message.includes(root), true);
      return true;
    },
  );
});

function forbidCredentials(): never {
  throw new Error("local git actions must not read credentials");
}

async function gitOut(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", root, ...args], { encoding: "utf8" });
  return result.stdout.trim();
}

test("commit stages synced sandbox files on the host work tree without credentials", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-git-commit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "spring-frontend");
  await fs.mkdir(repo);
  await initRepo(repo);
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "base"]);
  await git(repo, ["remote", "add", "origin", "https://github.com/acme/spring-frontend.git"]);
  await fs.writeFile(path.join(repo, "README.md"), "sandbox change\n");

  const result = await runAuthenticatedGit(
    "alice",
    root,
    { action: "commit", message: "feat: sandbox change" },
    { getCredential: forbidCredentials, baseEnv: { PATH: process.env.PATH } },
  );
  assert.match(result, /feat: sandbox change|已创建提交|[a-f0-9]{7}/);
  assert.equal(await gitOut(repo, ["log", "-1", "--pretty=%s"]), "feat: sandbox change");
  assert.equal(await gitOut(repo, ["status", "--porcelain"]), "");
});

test("init attaches origin on a work tree that has no git metadata", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-git-init-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "app.js"), "console.log(1)\n");

  const result = await runAuthenticatedGit(
    "alice",
    root,
    { action: "init", repository: "acme/widgets", provider: "github" },
    { getCredential: forbidCredentials, baseEnv: { PATH: process.env.PATH } },
  );
  assert.match(result, /https:\/\/github.com\/acme\/widgets\.git/);
  assert.equal(await gitOut(root, ["config", "--get", "remote.origin.url"]), "https://github.com/acme/widgets.git");
  await git(root, ["config", "user.email", "git@example.test"]);
  await git(root, ["config", "user.name", "Git"]);
  await runAuthenticatedGit(
    "alice",
    root,
    { action: "commit", message: "chore: import work tree" },
    { getCredential: forbidCredentials, baseEnv: { PATH: process.env.PATH } },
  );
  assert.equal(await gitOut(root, ["log", "-1", "--pretty=%s"]), "chore: import work tree");
});

test("import_bundle fast-forwards related history from a session bundle", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-git-bundle-ff-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "app");
  await fs.mkdir(repo);
  await initRepo(repo);
  await fs.writeFile(path.join(repo, "file.txt"), "one\n");
  await git(repo, ["add", "file.txt"]);
  await git(repo, ["commit", "-m", "one"]);

  const clone = path.join(root, "clone");
  await execFileAsync("git", ["clone", repo, clone], { encoding: "utf8" });
  await git(clone, ["config", "user.email", "git@example.test"]);
  await git(clone, ["config", "user.name", "Git"]);
  await fs.writeFile(path.join(clone, "file.txt"), "two\n");
  await git(clone, ["add", "file.txt"]);
  await git(clone, ["commit", "-m", "two"]);
  const bundle = path.join(root, "spring-frontend-b7405df.bundle");
  await git(clone, ["bundle", "create", bundle, "main"]);

  await runAuthenticatedGit(
    "alice",
    root,
    { action: "import_bundle", bundle: "spring-frontend-b7405df.bundle", directory: "app" },
    { getCredential: forbidCredentials, baseEnv: { PATH: process.env.PATH } },
  );
  assert.equal(await gitOut(repo, ["log", "-1", "--pretty=%s"]), "two");
  assert.equal(await fs.readFile(path.join(repo, "file.txt"), "utf8"), "two\n");
});

test("sandbox git-init bundle cannot replace original history; commit the synced tree instead", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-git-bundle-unrelated-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "spring-frontend");
  await fs.mkdir(repo);
  await initRepo(repo);
  await fs.writeFile(path.join(repo, "README.md"), "upstream\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "upstream"]);
  await git(repo, ["remote", "add", "origin", "https://github.com/acme/spring-frontend.git"]);

  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "cca-sandbox-git-init-"));
  t.after(() => fs.rm(sandbox, { recursive: true, force: true }));
  await initRepo(sandbox);
  await fs.writeFile(path.join(sandbox, "README.md"), "frontend commit\n");
  await git(sandbox, ["add", "README.md"]);
  await git(sandbox, ["commit", "-m", "frontend"]);
  const hash = await gitOut(sandbox, ["rev-parse", "--short", "HEAD"]);
  const bundleName = `spring-frontend-${hash}.bundle`;
  await git(sandbox, ["bundle", "create", path.join(root, bundleName), "main"]);
  await fs.writeFile(path.join(repo, "README.md"), "frontend commit\n");

  await assert.rejects(
    runAuthenticatedGit(
      "alice",
      root,
      { action: "import_bundle", bundle: bundleName, directory: "spring-frontend", branch: "main" },
      { getCredential: forbidCredentials, baseEnv: { PATH: process.env.PATH } },
    ),
    (reason: unknown) => {
      assert.ok(reason instanceof Error);
      assert.match(reason.message, /无法将 bundle 合并|无法从 Git bundle 导入/);
      assert.equal(reason.message.includes(BUNDLE_IMPORT_HINT), true);
      assert.doesNotMatch(reason.message, /宿主终端可以导入/);
      return true;
    },
  );

  await runAuthenticatedGit(
    "alice",
    root,
    { action: "commit", message: "feat: frontend", directory: "spring-frontend" },
    { getCredential: forbidCredentials, baseEnv: { PATH: process.env.PATH } },
  );
  assert.equal(await gitOut(repo, ["log", "-1", "--pretty=%s"]), "feat: frontend");
  assert.equal(await fs.readFile(path.join(repo, "README.md"), "utf8"), "frontend commit\n");
  assert.equal((await gitOut(repo, ["log", "--oneline"])).split("\n").length, 2);
});

test("import_bundle checks out a complete bundle into a repo with no commits", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-git-bundle-empty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source");
  await fs.mkdir(source);
  await initRepo(source);
  await fs.writeFile(path.join(source, "ok.txt"), "ok\n");
  await git(source, ["add", "ok.txt"]);
  await git(source, ["commit", "-m", "ok"]);
  await git(source, ["bundle", "create", path.join(root, "ok.bundle"), "main"]);

  const target = path.join(root, "target");
  await fs.mkdir(target);
  await git(target, ["init", "-b", "main"]);
  await git(target, ["config", "user.email", "git@example.test"]);
  await git(target, ["config", "user.name", "Git"]);

  await runAuthenticatedGit(
    "alice",
    root,
    { action: "import_bundle", bundle: "ok.bundle", directory: "target" },
    { getCredential: forbidCredentials, baseEnv: { PATH: process.env.PATH } },
  );
  assert.equal(await gitOut(target, ["log", "-1", "--pretty=%s"]), "ok");
  assert.equal(await fs.readFile(path.join(target, "ok.txt"), "utf8"), "ok\n");
});

test("import_bundle rejects paths outside the workspace", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cca-git-bundle-escape-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cca-git-bundle-outside-"));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await initRepo(root);
  await fs.writeFile(path.join(outside, "evil.bundle"), "not a bundle");
  await assert.rejects(
    runAuthenticatedGit(
      "alice",
      root,
      { action: "import_bundle", bundle: "../evil.bundle" },
      { getCredential: forbidCredentials },
    ),
    /项目目录内/,
  );
});
