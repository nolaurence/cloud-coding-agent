import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { CCA_WEB_FETCH_PLUGIN_FILE, CCA_WEB_FETCH_PROVIDER_ID, ccaWebFetchPluginSource } from "./ccaWebFetchPlugin.js";
import { credentialEnvName } from "./dshConfig.js";
import {
  DSH_SEARCH_API_KEY_ENV,
  DSH_SEARCH_BASE_URL_ENV,
  deepseekSearchBaseUrl,
  dshRuntimeCredentials,
  dshSearchPatch,
} from "./dshCredentials.js";

test("DSH search reuses the CCA provider key instead of requiring a raw DEEPSEEK_API_KEY in the host env", () => {
  const route = {
    id: "cca-primary",
    type: "openai" as const,
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-cca-provider",
    models: [{ id: "deepseek-chat" }],
  };
  const credentials = dshRuntimeCredentials(route, {});
  assert.equal(credentials[credentialEnvName("cca-primary")], "sk-cca-provider");
  assert.equal(credentials[DSH_SEARCH_API_KEY_ENV], "sk-cca-provider");
  assert.equal(credentials[DSH_SEARCH_BASE_URL_ENV], "https://api.deepseek.com/anthropic/v1");
  assert.equal(deepseekSearchBaseUrl("https://api.deepseek.com/v1"), "https://api.deepseek.com/anthropic/v1");
  assert.equal(deepseekSearchBaseUrl("https://gateway.internal/v1"), undefined);

  const patch = dshSearchPatch(route, {})!;
  assert.equal(patch.id, "web-search-deepseek");
  assert.equal(patch.config.apiKeyEnv, credentialEnvName("cca-primary"));
  assert.equal(patch.config.baseURL, "https://api.deepseek.com/anthropic/v1");
  assert.equal(JSON.stringify(patch).includes("sk-cca-provider"), false);
});

test("a distinct search endpoint can be supplied without putting secrets in the patch", () => {
  const route = {
    id: "cca-primary",
    type: "openai" as const,
    baseUrl: "https://gateway.internal/v1",
    apiKey: "sk-gateway",
    models: [{ id: "m1" }],
  };
  const credentials = dshRuntimeCredentials(route, {
    CCA_DSH_SEARCH_BASE_URL: "https://gateway.internal/anthropic/v1",
  });
  assert.equal(credentials[DSH_SEARCH_API_KEY_ENV], "sk-gateway");
  assert.equal(credentials[DSH_SEARCH_BASE_URL_ENV], "https://gateway.internal/anthropic/v1");
  assert.equal(dshRuntimeCredentials(route, {}).DEEPSEEK_SEARCH_BASE_URL, undefined);
});

test("Fake-IP fetch plugin is generated beside the DSH patch and pins cca-http", () => {
  const source = ccaWebFetchPluginSource("file:///tmp/dsh-web-fetch-http/index.js");
  assert.match(source, /198\.18\.0\.0\/15/);
  assert.match(source, /cca-http/);
  assert.match(source, /allowFakeIp/);
  assert.match(source, /HttpFetchProvider/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-dsh-fetch-"));
  try {
    fs.writeFileSync(path.join(root, CCA_WEB_FETCH_PLUGIN_FILE), source);
    assert.equal(fs.existsSync(path.join(root, CCA_WEB_FETCH_PLUGIN_FILE)), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.equal(CCA_WEB_FETCH_PROVIDER_ID, "cca-http");
});

test("generated fetch resolver accepts public literals, rejects private and Fake-IP literals", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cca-dsh-fetch-run-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, CCA_WEB_FETCH_PLUGIN_FILE);
  fs.writeFileSync(file, ccaWebFetchPluginSource());
  const plugin = await import(pathToFileURL(file).href) as {
    resolveAllowingFakeIp(hostname: string, signal?: AbortSignal): Promise<{ address: string; family: number }[]>;
  };
  const publicAddrs = await plugin.resolveAllowingFakeIp("8.8.8.8");
  assert.equal(publicAddrs[0]?.address, "8.8.8.8");
  await assert.rejects(() => plugin.resolveAllowingFakeIp("198.18.0.1"), /non-public/);
  await assert.rejects(() => plugin.resolveAllowingFakeIp("127.0.0.1"), /non-public/);
  await assert.rejects(() => plugin.resolveAllowingFakeIp("169.254.169.254"), /non-public/);
  await assert.rejects(() => plugin.resolveAllowingFakeIp("10.0.0.1"), /non-public/);
});
