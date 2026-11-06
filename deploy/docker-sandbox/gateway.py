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
OUTPUT_LIMIT = 256 * 1024
POLICY_FILE = Path(__file__).with_name("dockerSandboxPolicy.json")
if not POLICY_FILE.exists():  # Repository checkout; the installer copies the same file beside the gateway.
    POLICY_FILE = Path(__file__).resolve().parents[2] / "apps/server/src/dockerSandboxPolicy.json"
POLICY = json.loads(POLICY_FILE.read_text(encoding="utf8"))
RUNNER = r"""
const fs = require('node:fs/promises');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const exec = promisify(execFile);
(async () => {
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const {code, timeout_ms} = JSON.parse(input);
  const tools = {
    exec: async (command, options = {}) => {
      try {
        const r = await exec('/bin/bash', ['-lc', command], {
          cwd: options.cwd || '/workspace', timeout: Math.min(options.timeout_ms || timeout_ms, timeout_ms),
          maxBuffer: 256 * 1024, env: {...process.env, HOME: '/tmp', TMPDIR: '/tmp'},
        });
        return {stdout: r.stdout, stderr: r.stderr, exitCode: 0};
      } catch (e) {
        return {stdout: e.stdout || '', stderr: e.stderr || e.message, exitCode: typeof e.code === 'number' ? e.code : 1};
      }
    },
    read_file: (file) => fs.readFile(file, 'utf8'),
    write_file: async (file, content) => {
      await fs.mkdir(require('node:path').dirname(file), {recursive: true});
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
    if any(part in POLICY["directories"] or
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
            total += size
            if size > 8 * 1024 * 1024 or total > LIMIT or len(files) >= 10000:
                raise ValueError("Workspace synchronization limit exceeded (8 MiB/file, 64 MiB total, 10000 files)")
            # O_NOFOLLOW closes the symlink race; code containers have already exited on export.
            fd = os.open(file, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_BINARY", 0))
            with os.fdopen(fd, "rb") as stream:
                data = stream.read(8 * 1024 * 1024 + 1)
            if len(data) > 8 * 1024 * 1024:
                raise ValueError("Workspace file grew beyond synchronization limit")
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
    if dirty.exists():
        raise ValueError("Previous workspace export failed; recover remote files before retrying: " + str(workspace))
    incoming = request["files"]
    if not isinstance(incoming, dict) or len(incoming) > 10000:
        raise ValueError("Invalid workspace files")
    decoded, total = {}, 0
    for name, entry in incoming.items():
        target = safe_path(workspace, name)
        data = base64.b64decode(entry["data"], validate=True)
        total += len(data)
        if len(data) > 8 * 1024 * 1024 or total > LIMIT:
            raise ValueError("Workspace synchronization limit exceeded")
        decoded[name] = (target, data, entry.get("executable", False))
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
    command = ["docker", "run", "--rm", "-i", "--name", name, "--label", "cca.code-sandbox=true",
               "--init", "--user", f"{os.getuid()}:{os.getgid()}", "--cap-drop", "ALL",
               "--security-opt", "no-new-privileges", "--memory", "2g", "--memory-swap", "2g",
               "--cpus", "2", "--pids-limit", "256", "--read-only", "--tmpfs", "/tmp:rw,nosuid,size=512m",
               "--env", "HOME=/tmp", "--env", "XDG_CACHE_HOME=/tmp/.cache",
               "--env", "npm_config_cache=/tmp/.npm", "--env", "PIP_CACHE_DIR=/tmp/pip", "--env", "UV_CACHE_DIR=/tmp/uv",
               "--env", "GOPATH=/tmp/go", "--env", "GOCACHE=/tmp/go-build", "--env", "GOMODCACHE=/tmp/go/pkg/mod",
               "--env", "GRADLE_USER_HOME=/tmp/.gradle", "--env", "JAVA_TOOL_OPTIONS=-Duser.home=/tmp",
               "--network", "bridge" if request.get("network") is True else "none",
               "--workdir", "/workspace", "--mount", f"type=bind,src={workspace},dst=/workspace",
               "--entrypoint", "/usr/local/bin/node", IMAGE, "--disable-sigusr1", "-e", RUNNER]
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
    return {"stdout": output["stdout"].decode(errors="replace"), "stderr": output["stderr"].decode(errors="replace"),
            "exitCode": process.returncode, "timedOut": timed_out, "truncated": truncated}


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
    raise ValueError("Unknown sandbox action")


if __name__ == "__main__":
    try:
        print(json.dumps({"result": main()}, ensure_ascii=True))
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True))
        sys.exit(1)
