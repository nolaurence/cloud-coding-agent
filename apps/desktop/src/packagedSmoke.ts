import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startupFailureDetail, waitForServerReady } from "./lifecycle.js";

const executableArgument = process.argv[2];
assert.ok(executableArgument, "Usage: npm run test:desktop:packaged -- <unpacked executable>");
const executable = path.resolve(executableArgument);
const resources = path.resolve(path.dirname(executable), process.platform === "darwin" ? "../Resources" : "resources");
const entry = path.join(resources, "app.asar", "apps", "server", "dist", "index.js");
assert.ok(fs.existsSync(executable), `Missing executable: ${executable}`);
assert.ok(fs.existsSync(path.join(resources, "app.asar")), `Missing packaged app: ${resources}`);
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cca-packaged-smoke-"));
const child = spawn(executable, [entry], {
  cwd: directory,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    CCA_DATA_DIR: directory,
    WORKSPACE_ROOT: path.join(directory, "workspaces"),
    DATABASE_URL: `h2:${path.join(directory, "cca.db")}`,
    CCA_LOCAL_MODE: "true",
    BROWSER_BACKEND: "electron-ipc",
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: "0",
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
  windowsHide: true,
});
let output = "";
const captureOutput = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-16_000); };
child.stdout!.on("data", captureOutput);
child.stderr!.on("data", captureOutput);
const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
let ready = false;
try {
  const origin = await waitForServerReady(child);
  const runtime = await fetch(`${origin}/api/runtime`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(runtime.status, 200);
  assert.deepEqual(await runtime.json(), { localMode: true, database: "h2" });
  const page = await fetch(origin, { signal: AbortSignal.timeout(5_000) });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/);
  assert.ok(fs.existsSync(path.join(directory, "cca.db")), "The packaged runtime did not create its embedded database");
  ready = true;
  console.log(`Packaged server, local database and web UI are ready: ${origin}`);
} catch (error) {
  throw new Error(startupFailureDetail(error, output, null), { cause: error });
} finally {
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    if (child.exitCode === null && child.signalCode === null) {
      if (child.connected) child.send({ type: "cca-server-shutdown" });
      else child.kill();
    }
    const exitCode = await closed;
    if (ready) assert.equal(exitCode, 0, `Packaged server failed to shut down cleanly\n${output}`);
  } finally {
    clearTimeout(timer);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
