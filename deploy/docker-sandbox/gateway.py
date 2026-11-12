#!/usr/bin/env python3
"""Restricted SSH entrypoint. Only this program talks to the Docker daemon."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent / "workspaces"
IMAGE = "ghcr.io/converge-ai-labs/a13n-sandbox:0.3.0"
LIMIT = 64 * 1024 * 1024
MAX_FILE = 8 * 1024 * 1024
MAX_FILES = 10000
OUTPUT_LIMIT = 256 * 1024
POLICY_FILE = Path(__file__).with_name("dockerSandboxPolicy.json")
if not POLICY_FILE.exists():  # Repository checkout; the installer copies the same file beside the gateway.
    POLICY_FILE = Path(__file__).resolve().parents[2] / "apps/server/src/dockerSandboxPolicy.json"
POLICY = json.loads(POLICY_FILE.read_text(encoding="utf8"))
RUNNER = r"""
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');
const {execFile} = require('node:child_process');
const {lookup} = require('node:dns/promises');
const {promisify} = require('node:util');
const exec = promisify(execFile);
const SANDBOX_ROOT = '/workspace';
const hostWorkspace = process.env.CCA_HOST_WORKSPACE || '';
function posixNorm(value) {
  const collapsed = path.posix.normalize(String(value).replaceAll('\\', '/'));
  return collapsed !== '/' && collapsed.endsWith('/') ? collapsed.slice(0, -1) : collapsed;
}
function mapCwd(cwd) {
  const root = SANDBOX_ROOT;
  if (!cwd) return {cwd: root};
  const requested = posixNorm(cwd);
  if (requested.includes('\0')) return {cwd: root, error: 'cwd 无效'};
  const host = hostWorkspace ? posixNorm(hostWorkspace) : '';
  let mapped;
  if (host && (requested === host || requested.startsWith(host + '/'))) mapped = posixNorm(root + requested.slice(host.length));
  else if (requested === root || requested.startsWith(root + '/')) mapped = requested;
  else if (!requested.startsWith('/')) mapped = posixNorm(root + '/' + requested);
  else mapped = requested;
  if (mapped !== root && !mapped.startsWith(root + '/')) return {cwd: mapped, error: 'cwd 不在沙箱工作区内: ' + cwd};
  return {cwd: mapped};
}
function isBlocked(address, allowFakeIp) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    if (allowFakeIp && a === 198 && b >= 18 && b <= 19) return false;
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 198 && b >= 18 && b <= 19);
  }
  if (!net.isIPv6(address)) return true;
  const normalized = address.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice(7);
    return net.isIPv4(mapped) ? isBlocked(mapped, allowFakeIp) : true;
  }
  const fake6 = normalized === '2001:2::' || normalized.startsWith('2001:2:');
  if (fake6) return !allowFakeIp;
  return normalized === '::1' || normalized === '::' || normalized.startsWith('fc') ||
    normalized.startsWith('fd') || /^fe[89ab]/.test(normalized) || normalized.startsWith('ff');
}
async function assertSafeFetch(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { const e = new Error('地址无效'); e.code = 'EINVAL'; throw e; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    const e = new Error('仅支持不含凭据的 HTTP 或 HTTPS 地址'); e.code = 'WEB_BLOCKED_URL'; throw e;
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = net.isIP(hostname) ? [hostname]
    : (await lookup(hostname, {all: true, verbatim: true})).map((entry) => entry.address);
  const allowFakeIp = !net.isIP(hostname);
  if (!addresses.length || addresses.some((address) => isBlocked(address, allowFakeIp))) {
    const e = new Error('URL hostname "' + hostname + '" resolves to a non-public IP address');
    e.code = 'WEB_BLOCKED_URL'; throw e;
  }
  return url;
}
(async () => {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const {code, timeout_ms} = JSON.parse(input);
  const tools = {
    exec: async (command, options = {}) => {
      const mapped = mapCwd(options.cwd);
      if (mapped.error) return {stdout: '', stderr: mapped.error, exitCode: 1, timedOut: false, errorCode: 'EINVAL'};
      try {
        const st = await fs.stat(mapped.cwd);
        if (!st.isDirectory()) return {stdout: '', stderr: 'cwd is not a directory: ' + mapped.cwd, exitCode: 1, timedOut: false, errorCode: 'ENOTDIR'};
      } catch (e) {
        if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
          return {stdout: '', stderr: 'directory does not exist: ' + mapped.cwd, exitCode: 1, timedOut: false, errorCode: 'ENOENT'};
        }
        throw e;
      }
      try {
        const r = await exec('/bin/bash', ['-lc', command], {
          cwd: mapped.cwd, timeout: Math.min(options.timeout_ms || timeout_ms, timeout_ms),
          maxBuffer: 256 * 1024, env: {...process.env, HOME: '/tmp', TMPDIR: '/tmp'},
        });
        return {stdout: r.stdout, stderr: r.stderr, exitCode: 0, timedOut: false};
      } catch (e) {
        const timedOut = e.killed === true || e.code === 'ETIMEDOUT';
        return {
          stdout: e.stdout || '', stderr: e.stderr || e.message,
          exitCode: typeof e.code === 'number' ? e.code : 1, timedOut,
          errorCode: timedOut ? 'TIMEOUT' : (typeof e.code === 'string' ? e.code : undefined),
        };
      }
    },
    fetch: async (raw, options = {}) => {
      try {
        let current = String(raw);
        let response;
        const signal = AbortSignal.timeout(Math.min(options.timeout_ms || 30000, timeout_ms));
        for (let hop = 0; hop <= 5; hop++) {
          const parsed = await assertSafeFetch(current);
          response = await fetch(parsed, {redirect: 'manual', signal, headers: {'user-agent': 'cca-sandbox'}});
          const location = response.headers.get('location');
          if (response.status < 300 || response.status >= 400 || !location) break;
          const next = new URL(location, parsed);
          if (next.origin !== parsed.origin) {
            return {ok: false, status: response.status, errorCode: 'WEB_BLOCKED_URL', stderr: 'cross-origin redirect requires a new fetch', timedOut: false};
          }
          current = next.href;
        }
        const body = await response.text();
        return {ok: response.ok, status: response.status, url: current, body: body.slice(0, 100000), timedOut: false};
      } catch (e) {
        const timedOut = e.name === 'TimeoutError' || e.code === 'ETIMEDOUT';
        return {ok: false, stderr: e.message, timedOut, errorCode: e.code === 'WEB_BLOCKED_URL' ? 'WEB_BLOCKED_URL' : (timedOut ? 'TIMEOUT' : 'FETCH_ERROR')};
      }
    },
    read_file: (file) => fs.readFile(file, 'utf8'),
    write_file: async (file, content) => {
      await fs.mkdir(path.dirname(file), {recursive: true});
      await fs.writeFile(file, content); return {path: file};
    },
    list_files: (directory = '.') => fs.readdir(directory),
  };
  const print = (...values) => console.log(...values.map(v => typeof v === 'string' ? v : JSON.stringify(v)));
  const result = await new (Object.getPrototypeOf(async function(){}).constructor)('tools', 'print', code)(tools, print);
  if (result !== undefined) print(result);
})().catch(e => { console.error(e.stack || String(e)); process.exitCode = 1; });
"""


def docker(*args, check=True):
    return subprocess.run(["docker", *args], check=check, capture_output=True, text=True, timeout=30)


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value):
        raise ValueError("Invalid sandbox identifier")
    return value


def ignored(name, directory=False):
    parts = name.split("/")
    prefixes = POLICY.get("directoryPrefixes", [])
    if any(part in POLICY["directories"] or any(part.startswith(prefix) for prefix in prefixes) or
           ((directory or index < len(parts) - 1) and any(part.endswith(s) for s in POLICY["directorySuffixes"]))
           for index, part in enumerate(parts)):
        return True
    if any(parts[index:index + len(pattern)] == pattern
           for pattern in POLICY["paths"] for index in range(len(parts))):
        return True
    return not directory and (parts[-1] in POLICY["files"] or parts[-1].startswith(".coverage.") or
                              any(parts[-1].endswith(s) for s in POLICY["fileSuffixes"]))


def safe_path(root, name):
    if not isinstance(name, str) or not name or "\\" in name or "\x00" in name:
        raise ValueError("Invalid workspace path")
    parts = name.split("/")
    if ignored(name) or any(p in ("", ".", "..") or ":" in p for p in parts):
        raise ValueError("Invalid workspace path")
    target = root
    for part in parts:
        target = target / part
        if target.is_symlink():
            raise ValueError("Workspace symlinks cannot be synchronized")
    return target


def walk_error(error):
    raise error  # An unreadable source directory must not look like a deletion.


def snapshot(root):
    files, total = {}, 0
    for directory, dirs, names in os.walk(root, followlinks=False, onerror=walk_error):
        dirs[:] = [d for d in dirs if not ignored((Path(directory) / d).relative_to(root).as_posix(), True)
                   and not (Path(directory) / d).is_symlink()]
        for name in names:
            file = Path(directory) / name
            if file.is_symlink() or not file.is_file():
                continue
            relative = file.relative_to(root).as_posix()
            if ignored(relative):
                continue
            safe_path(root, relative)
            size = file.stat().st_size
            if size > MAX_FILE:
                continue
            if total + size > LIMIT or len(files) >= MAX_FILES:
                raise ValueError("Workspace synchronization limit exceeded (8 MiB/file, 64 MiB total, 10000 files)")
            # O_NOFOLLOW closes the symlink race; code containers have already exited on export.
            fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
            with os.fdopen(fd, "rb") as stream:
                data = stream.read(MAX_FILE + 1)
            if len(data) > MAX_FILE:
                continue
            total += size
            files[relative] = {"data": base64.b64encode(data).decode(), "hash": hashlib.sha256(data).hexdigest(), "executable": bool(file.stat().st_mode & 0o111)}
    return files


def stop(name):
    # Only our generated per-call containers can ever be removed.
    if re.fullmatch(r"cca-code-[a-f0-9]{32}", name):
        docker("rm", "-f", name, check=False)


def run(request):
    import fcntl
    workspace = ROOT / identifier(request["workspace"])
    ROOT.mkdir(parents=True, exist_ok=True)
    with open(ROOT / (workspace.name + ".lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return run_locked(request, workspace)


def run_locked(request, workspace):
    if request.get("workspace_policy_version") != POLICY["version"]:
        raise ValueError("Sandbox workspace policy mismatch; update both the CCA application and sandbox gateway")
    run_id = identifier(request["run"])
    cancelled = ROOT / (run_id + ".cancelled")
    if cancelled.exists():
        cancelled.unlink()
        raise ValueError("Code execution cancelled")
    # Only gateway-owned workspace directories may be reset; never follow a
    # symlink placed by a previous execution or touch a different workspace.
    if workspace.parent.resolve() != ROOT.resolve() or workspace.is_symlink():
        raise ValueError("Invalid sandbox workspace directory")
    dirty = ROOT / (workspace.name + ".dirty")
    incoming = request["files"]
    if not isinstance(incoming, dict) or len(incoming) > MAX_FILES:
        raise ValueError("Invalid workspace files")
    decoded, total = {}, 0
    for name, entry in incoming.items():
        target = safe_path(workspace, name)
        data = base64.b64decode(entry["data"], validate=True)
        total += len(data)
        if len(data) > MAX_FILE or total > LIMIT:
            raise ValueError("Workspace synchronization limit exceeded")
        decoded[name] = (target, data, entry.get("executable", False))
    if dirty.exists():
        # Keep the dirty marker until this run exports successfully. Recovered
        # bytes live in `decoded` so discard_tree cannot drop unsynced source.
        merge_recovered_source(workspace, decoded)
    code = request["code"]
    if not isinstance(code, str) or not code.strip() or len(code.encode()) > 256 * 1024:
        raise ValueError("Invalid code block")
    timeout = request.get("timeout_ms", 60000)
    if not isinstance(timeout, int) or not 100 <= timeout <= 300000:
        raise ValueError("Invalid timeout")
    # Never reuse the previous execution directory or its dependencies.
    # An old gateway's clean workspace is disposable: its source was exported.
    if workspace.exists():
        discard_tree(workspace)
    workspace.mkdir()
    for target, data, executable in decoded.values():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        target.chmod(0o755 if executable else 0o644)
    dirty.touch()
    try:
        output = execute_code(request, workspace, code, timeout)
        after = snapshot(workspace)
        changes = {n: e for n, e in after.items() if n not in incoming or e["data"] != incoming[n]["data"] or e["executable"] != incoming[n].get("executable", False)}
    except BaseException:
        # Keep unsynchronized source for recovery, but discard known generated
        # files even when export exceeds the limits or execution fails.
        prune_generated(workspace)
        raise
    result = {**output, "files": changes, "deleted": list(incoming.keys() - after.keys())}
    try:
        discard_tree(workspace)
    except Exception as error:
        # Cleanup may have removed some source already. Preserve the complete
        # export so a filesystem/permission failure cannot lose those edits.
        recovery = ROOT / (workspace.name + ".recovery.json")
        recovery.write_text(json.dumps(result), encoding="utf8")
        recovery.chmod(0o600)
        raise RuntimeError("Workspace cleanup failed; recover exported changes from " + str(recovery)) from error
    dirty.unlink()
    return result


def merge_recovered_source(workspace, decoded):
    """Overlay unsynchronized remote source onto the next run without executing user code."""
    if not workspace.exists():
        return
    if workspace.is_symlink() or workspace.parent.resolve() != ROOT.resolve():
        raise ValueError("Invalid sandbox workspace directory")
    prune_generated(workspace)
    for name, entry in snapshot(workspace).items():
        data = base64.b64decode(entry["data"], validate=True)
        decoded[name] = (safe_path(workspace, name), data, entry.get("executable", False))


def recover(request):
    import fcntl
    workspace = ROOT / identifier(request["workspace"])
    ROOT.mkdir(parents=True, exist_ok=True)
    with open(ROOT / (workspace.name + ".lock"), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return recover_locked(request, workspace)


def recover_locked(request, workspace):
    if request.get("workspace_policy_version") != POLICY["version"]:
        raise ValueError("Sandbox workspace policy mismatch; update both the CCA application and sandbox gateway")
    if workspace.parent.resolve() != ROOT.resolve() or workspace.is_symlink():
        raise ValueError("Invalid sandbox workspace directory")
    files = {}
    if workspace.exists():
        prune_generated(workspace)
        files = snapshot(workspace)
    return {"stdout": "", "stderr": "", "exitCode": 0, "timedOut": False, "truncated": False,
            "files": files, "deleted": [], "recovered": True}


def discard_tree(root):
    # Go modules and other package managers can create read-only directories.
    # Only make our own execution tree writable, without following symlinks.
    if root.is_symlink():
        raise ValueError("Cannot remove a symlink as a sandbox workspace")
    root.chmod(root.stat().st_mode | 0o700)
    for directory, dirs, names in os.walk(root, followlinks=False, onerror=walk_error):
        for name in dirs:
            target = Path(directory) / name
            if not target.is_symlink():
                target.chmod(target.stat().st_mode | 0o700)
        if os.name == "nt":  # Offline tests also run on Windows.
            for name in names:
                target = Path(directory) / name
                if not target.is_symlink():
                    target.chmod(target.stat().st_mode | 0o600)
    shutil.rmtree(root)


def prune_generated(root):
    for directory, dirs, names in os.walk(root, followlinks=False, onerror=walk_error):
        for name in dirs[:]:
            target = Path(directory) / name
            if target.is_symlink():
                target.unlink()
                dirs.remove(name)
            elif ignored(target.relative_to(root).as_posix(), True):
                discard_tree(target)
                dirs.remove(name)
        for name in names:
            target = Path(directory) / name
            if target.is_symlink() or ignored(target.relative_to(root).as_posix()):
                target.unlink()


def execute_code(request, workspace, code, timeout):
    run_id = identifier(request["run"])
    cancelled = ROOT / (run_id + ".cancelled")
    name = "cca-code-" + run_id
    host_workspace = request.get("host_workspace") or ""
    if not isinstance(host_workspace, str) or "\x00" in host_workspace or len(host_workspace) > 4096:
        raise ValueError("Invalid host workspace")
    command = ["docker", "run", "--rm", "-i", "--name", name, "--label", "cca.code-sandbox=true",
               "--init", "--user", f"{os.getuid()}:{os.getgid()}", "--cap-drop", "ALL",
               "--security-opt", "no-new-privileges", "--memory", "2g", "--memory-swap", "2g",
               "--cpus", "2", "--pids-limit", "256", "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=512m",
               "--env", "HOME=/tmp", "--env", "XDG_CACHE_HOME=/tmp/.cache",
               "--env", "npm_config_cache=/tmp/.npm", "--env", "PIP_CACHE_DIR=/tmp/pip", "--env", "UV_CACHE_DIR=/tmp/uv",
               "--env", "GOPATH=/tmp/go", "--env", "GOCACHE=/tmp/go-build", "--env", "GOMODCACHE=/tmp/go/pkg/mod",
               "--env", "GRADLE_USER_HOME=/tmp/.gradle", "--env", "JAVA_TOOL_OPTIONS=-Duser.home=/tmp",
               "--env", "CCA_HOST_WORKSPACE=" + host_workspace,
               "--network", "bridge" if request.get("network") is True else "none",
               "--workdir", "/workspace", "--mount", f"type=bind,src={workspace},dst=/workspace",
               "--entrypoint", "/usr/local/bin/node", IMAGE, "--disable-sigusr1", "-e", RUNNER]
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"):
        value = os.environ.get(key)
        if value:
            command.extend(["--env", f"{key}={value}"])
    output = {"stdout": bytearray(), "stderr": bytearray()}
    timed_out, truncated = False, False
    process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        process.stdin.write(json.dumps({"code": code, "timeout_ms": timeout}).encode())
        process.stdin.close()
        if cancelled.exists():
            stop(name)
            process.kill()
        selector = selectors.DefaultSelector()
        for stream, key in [(process.stdout, "stdout"), (process.stderr, "stderr")]:
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, key)
        deadline = time.monotonic() + timeout / 1000
        while selector.get_map():
            if time.monotonic() > deadline or cancelled.exists():
                timed_out = not cancelled.exists()
                stop(name)
                process.kill()
                break
            for key, _ in selector.select(0.1):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                remaining = OUTPUT_LIMIT - sum(len(v) for v in output.values())
                output[key.data].extend(chunk[:max(0, remaining)])
                if len(chunk) > remaining:
                    truncated = True
                    stop(name)
                    process.kill()
                    break
            if truncated:
                break
        process.wait(timeout=10)
    finally:
        stop(name)
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        cancelled.unlink(missing_ok=True)
    result = {"stdout": output["stdout"].decode(errors="replace"), "stderr": output["stderr"].decode(errors="replace"),
              "exitCode": process.returncode, "timedOut": timed_out, "truncated": truncated}
    if timed_out:
        result["errorCode"] = "TIMEOUT"
    return result


def main():
    raw = sys.stdin.buffer.read(LIMIT * 2 + 1)
    if len(raw) > LIMIT * 2:
        raise ValueError("Request too large")
    request = json.loads(raw)
    action = request.get("action")
    if action == "health":
        docker("image", "inspect", IMAGE)
        return {"docker": docker("version", "--format", "{{.Server.Version}}").stdout.strip(), "image": IMAGE,
                "workspacePolicyVersion": POLICY["version"]}
    if action == "cancel":
        run_id = identifier(request["run"])
        ROOT.mkdir(parents=True, exist_ok=True)
        (ROOT / (run_id + ".cancelled")).touch()
        stop("cca-code-" + run_id)
        return {"cancelled": True}
    if action == "run":
        return run(request)
    if action == "recover":
        return recover(request)
    raise ValueError("Unknown sandbox action")


if __name__ == "__main__":
    try:
        print(json.dumps({"result": main()}, ensure_ascii=True))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True))
        sys.exit(1)
