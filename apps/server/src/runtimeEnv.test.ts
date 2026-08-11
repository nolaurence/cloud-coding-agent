import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { clearBootstrapCredentials, packagedCopilotCliPath, sanitizedCopilotRuntimeEnv } from "./runtimeEnv.js";

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
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.COPILOT_CLI_PATH, undefined);
  assert.equal(env.ELECTRON_ENABLE_LOGGING, undefined);
  assert.equal(env.ELECTRON_EXTRA_LAUNCH_ARGS, undefined);
  assert.equal(sanitizedCopilotRuntimeEnv({ ELECTRON_RUN_AS_NODE: "true" }).ELECTRON_RUN_AS_NODE, undefined);
  for (const key of ["ADMIN_PASSWORD", "DATABASE_URL", "OPENAI_API_KEY", "GITHUB_TOKEN", "FEISHU_APP_SECRET", "CCA_DATA_DIR"]) assert.equal(env[key], undefined);
});

test("bootstrap credentials are deleted after authentication initialization", () => {
  const env: NodeJS.ProcessEnv = { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "secret", PATH: "/bin" };
  clearBootstrapCredentials(env);
  assert.deepEqual(env, { PATH: "/bin" });
});


test("packaged Electron uses the unpacked native Copilot CLI", () => {
  const resourcesPath = "/opt/Cloud Coding Agent/resources";
  const expected = path.join(resourcesPath, "app.asar.unpacked", "node_modules", "@github", "copilot-win32-arm64", "copilot.exe");
  const runtime = { resourcesPath, platform: "win32" as const, arch: "arm64", exists: (candidate: string) => candidate === expected };
  assert.equal(packagedCopilotCliPath(runtime), expected);
  const env = sanitizedCopilotRuntimeEnv({ ELECTRON_RUN_AS_NODE: "1" }, runtime);
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(env.COPILOT_CLI_PATH, expected);
});

test("an explicit Copilot CLI path is not replaced", () => {
  const env = sanitizedCopilotRuntimeEnv(
    { ELECTRON_RUN_AS_NODE: "1", COPILOT_CLI_PATH: "/custom/copilot" },
    { resourcesPath: "/resources", platform: "darwin", arch: "x64", exists: () => true },
  );
  assert.equal(env.COPILOT_CLI_PATH, "/custom/copilot");
});
