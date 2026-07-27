import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildAuthenticatedGitEnv,
  normalizeGitRemote,
  runAuthenticatedGit,
  type GitRunner,
} from "./gitOperations.js";

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
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "unsafe.key",
      GIT_CONFIG_VALUE_0: "unsafe-value",
    },
    normalizeGitRemote("https://github.com/acme/widgets"),
    { username: "octocat", token },
  );

  assert.equal(env.PATH, "test-path");
  assert.equal(env.GIT_TRACE, undefined);
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_CONFIG_COUNT, "3");
  assert.equal(env.GIT_CONFIG_KEY_0, "http.https://github.com/.extraHeader");
  assert.match(env.GIT_CONFIG_VALUE_0 ?? "", /^Authorization: Basic /);
  assert.equal(env.GIT_CONFIG_KEY_1, "credential.helper");
  assert.equal(env.GIT_CONFIG_VALUE_1, "");
  assert.ok(!JSON.stringify(env).includes(token));
});

test("pull fetches with credentials and integrates without credentials", async () => {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const runGit: GitRunner = async (args, options) => {
    calls.push({ args, env: options.env });
    if (args[0] === "remote") return { stdout: "git@github.com:acme/widgets.git\n", stderr: "" };
    if (args.includes("fetch")) return { stdout: "fetched", stderr: "" };
    return { stdout: "updated", stderr: "" };
  };

  const result = await runAuthenticatedGit(
    "alice",
    process.cwd(),
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

test("push disables hooks and redacts credentials from failures", async () => {
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
      process.cwd(),
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
