import assert from "node:assert/strict";
import test from "node:test";
import { clearBootstrapCredentials, sanitizedCopilotRuntimeEnv, sanitizedDshRuntimeEnv } from "./runtimeEnv.js";

test("Copilot runtime environment preserves essentials without service or provider secrets", () => {
  const env = sanitizedCopilotRuntimeEnv({
    PATH: "/bin", HOME: "/home/user", LANG: "en_US.UTF-8", COPILOT_CUSTOM_SETTING: "on",
    ADMIN_PASSWORD: "admin-secret", DATABASE_URL: "mysql://secret", OPENAI_API_KEY: "provider-secret",
    GITHUB_TOKEN: "git-secret", GH_TOKEN: "gh-secret", GH_HOST: "github.example.com", FEISHU_APP_SECRET: "service-secret", CCA_DATA_DIR: "/private/data",
    ELECTRON_RUN_AS_NODE: "1", ELECTRON_ENABLE_LOGGING: "secret-ish", ELECTRON_EXTRA_LAUNCH_ARGS: "--unsafe",
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/home/user");
  assert.equal(env.COPILOT_CUSTOM_SETTING, "on");
  assert.equal(env.COPILOT_GITHUB_TOKEN, "gh-secret");
  assert.equal(env.GH_HOST, "github.example.com");
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(typeof env.COPILOT_HOME, "string");
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.ELECTRON_ENABLE_LOGGING, undefined);
  assert.equal(env.ELECTRON_EXTRA_LAUNCH_ARGS, undefined);
  for (const key of ["ADMIN_PASSWORD", "DATABASE_URL", "OPENAI_API_KEY", "GITHUB_TOKEN", "FEISHU_APP_SECRET", "CCA_DATA_DIR"]) assert.equal(env[key], undefined);
});

test("bootstrap credentials are deleted after authentication initialization", () => {
  const env: NodeJS.ProcessEnv = { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "secret", PATH: "/bin" };
  clearBootstrapCredentials(env);
  assert.deepEqual(env, { PATH: "/bin" });
});

test("an explicit Copilot CLI path passes through unchanged", () => {
  const env = sanitizedCopilotRuntimeEnv({ COPILOT_CLI_PATH: "/custom/copilot" });
  assert.equal(env.COPILOT_CLI_PATH, "/custom/copilot");
});

test("DSH runtime environment isolates its home and only injects route credentials", () => {
  const env = sanitizedDshRuntimeEnv(
    "/data/dsh-home/thread-1",
    { CCA_DSH_KEY_PROVIDER: "sk-secret" },
    {
      PATH: "/bin",
      HOME: "/home/user",
      DSH_PERMISSION_MODE: "workspace-write",
      CCA_DSH_PATH: "/opt/dsh",
      DSH_HOME: "/old/home",
      ELECTRON_RUN_AS_NODE: "1",
      ELECTRON_ENABLE_LOGGING: "1",
      ADMIN_PASSWORD: "admin-secret",
      DATABASE_URL: "mysql://secret",
      OPENAI_API_KEY: "provider-secret",
      CCA_DATA_DIR: "/private/data",
    },
  );
  assert.equal(env.PATH, "/bin");
  assert.equal(env.HOME, "/data/dsh-home/thread-1");
  assert.equal(env.USERPROFILE, "/data/dsh-home/thread-1");
  assert.equal(env.DSH_PERMISSION_MODE, "workspace-write");
  assert.equal(env.CCA_DSH_PATH, "/opt/dsh");
  assert.equal(env.DSH_HOME, "/data/dsh-home/thread-1");
  assert.equal(env.CCA_DSH_KEY_PROVIDER, "sk-secret");
  assert.equal(env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(env.ELECTRON_ENABLE_LOGGING, undefined);
  for (const key of ["ADMIN_PASSWORD", "DATABASE_URL", "OPENAI_API_KEY", "CCA_DATA_DIR"]) {
    assert.equal(env[key], undefined);
  }
});
