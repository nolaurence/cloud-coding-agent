import { existsSync } from "node:fs";
import path from "node:path";
import { COPILOT_HOME } from "./env.js";

const SYSTEM_KEYS = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMP", "TEMP", "TMPDIR",
  "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "COLORTERM", "SSH_AUTH_SOCK",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
] as const;

// Only Copilot runtime configuration may cross the server/runtime process boundary.
// Credentials for providers, Git hosts, databases and the CCA service are intentionally excluded.
const COPILOT_PREFIXES = ["COPILOT_", "GH_COPILOT_"] as const;

const COPILOT_AUTH_KEYS = ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"] as const;
const BLOCKED_KEYS = new Set([
  "COPILOT_SDK_AUTH_TOKEN", // supplied explicitly by the SDK when configured, never inherited
  "ADMIN_USERNAME", "ADMIN_PASSWORD", "DATABASE_URL", "CCA_DATA_DIR", "WORKSPACE_ROOT",
]);

export interface PackagedCopilotRuntime {
  resourcesPath?: string;
  platform: NodeJS.Platform;
  arch: string;
  exists: (candidate: string) => boolean;
}

function currentPackagedRuntime(): PackagedCopilotRuntime {
  return {
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
    platform: process.platform,
    arch: process.arch,
    exists: existsSync,
  };
}

export function packagedCopilotCliPath(runtime: PackagedCopilotRuntime): string | undefined {
  if (!runtime.resourcesPath || !["darwin", "linux", "win32"].includes(runtime.platform)) return undefined;
  const executable = runtime.platform === "win32" ? "copilot.exe" : "copilot";
  const candidate = path.join(
    runtime.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@github",
    `copilot-${runtime.platform}-${runtime.arch}`,
    executable,
  );
  return runtime.exists(candidate) ? candidate : undefined;
}

export function sanitizedCopilotRuntimeEnv(
  source: NodeJS.ProcessEnv = process.env,
  runtime: PackagedCopilotRuntime = currentPackagedRuntime(),
): NodeJS.ProcessEnv {
  const target: NodeJS.ProcessEnv = {};
  for (const key of SYSTEM_KEYS) if (source[key] !== undefined) target[key] = source[key];
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && COPILOT_PREFIXES.some((prefix) => key.startsWith(prefix)) && !BLOCKED_KEYS.has(key)) target[key] = value;
  }
  const githubToken = COPILOT_AUTH_KEYS.map((key) => source[key]?.trim()).find(Boolean);
  if (githubToken) target.COPILOT_GITHUB_TOKEN = githubToken;
  if (source.GH_HOST?.trim()) target.GH_HOST = source.GH_HOST.trim();
  // The SDK launches its JavaScript platform loader with process.execPath. In a packaged
  // Electron server process that executable is Electron, so this exact mode flag is
  // required for the loader to run as Node. No other ELECTRON_* variables are inherited.
  if (source.ELECTRON_RUN_AS_NODE === "1") {
    target.ELECTRON_RUN_AS_NODE = "1";
    // Prefer the unpacked native CLI. Electron's Node mode can run the SDK's JS
    // loader, but that loader sees Electron's script path as an extra CLI argument.
    target.COPILOT_CLI_PATH ??= packagedCopilotCliPath(runtime);
  }
  target.COPILOT_HOME = COPILOT_HOME;
  return target;
}

export function clearBootstrapCredentials(environment: NodeJS.ProcessEnv = process.env): void {
  delete environment.ADMIN_USERNAME;
  delete environment.ADMIN_PASSWORD;
}
