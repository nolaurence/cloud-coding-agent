#!/usr/bin/env python3
"""Provision a forced-command SSH key; requires Python paramiko (setup only)."""
import argparse
import base64
import getpass
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import paramiko
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

parser = argparse.ArgumentParser()
parser.add_argument("--host", required=True)
parser.add_argument("--username", required=True)
parser.add_argument("--port", type=int, default=22)
parser.add_argument("--data-dir", type=Path, required=True)
parser.add_argument("--password-stdin", action="store_true", help="Read password from stdin, never a CLI argument")
args = parser.parse_args()
password = sys.stdin.readline().rstrip("\r\n") if args.password_stdin else getpass.getpass("SSH password: ")
client = paramiko.SSHClient()
client.load_system_host_keys()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(args.host, port=args.port, username=args.username, password=password, timeout=15)
del password
try:
    sftp = client.open_sftp()
    remote_home = sftp.normalize(".")
    remote_root = remote_home + "/cca-code-sandbox"
    for directory in [remote_root, remote_root + "/workspaces", remote_home + "/.ssh"]:
        try: sftp.mkdir(directory, 0o700)
        except OSError: sftp.stat(directory)
    gateway = remote_root + "/gateway.py"
    sftp.put(str(Path(__file__).with_name("gateway.py")), gateway)
    sftp.chmod(gateway, 0o700)
    key_root = args.data_dir.resolve() / "sandbox-ssh"
    key_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    identity = key_root / "id_ed25519"
    if not identity.exists():
        key = Ed25519PrivateKey.generate()
        private = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH, serialization.NoEncryption())
        with open(identity, "xb") as file: file.write(private)
        identity.chmod(0o600)
        if os.name == "nt":
            subprocess.run(["icacls", str(identity), "/inheritance:r", "/grant:r", getpass.getuser() + ":F"], check=True, capture_output=True)
    key = serialization.load_ssh_private_key(identity.read_bytes(), password=None)
    public = key.public_key().public_bytes(serialization.Encoding.OpenSSH, serialization.PublicFormat.OpenSSH).decode()
    authorized = remote_home + "/.ssh/authorized_keys"
    try:
        with sftp.open(authorized) as file: existing = file.read().decode()
    except OSError: existing = ""
    # Replace only this exact key; all other users and previous sandboxes remain intact.
    lines = [line for line in existing.splitlines() if public.split()[1] not in line.split()]
    lines.append('restrict,command="python3 ' + gateway + '" ' + public + " cca-code-sandbox")
    with sftp.open(authorized, "w") as file: file.write("\n".join(lines) + "\n")
    sftp.chmod(authorized, 0o600)
    host_key = client.get_transport().get_remote_server_key()
    hosts = key_root / "known_hosts"
    host = args.host if args.port == 22 else f"[{args.host}]:{args.port}"
    hosts.write_text(host + " " + host_key.get_name() + " " + host_key.get_base64() + "\n", encoding="utf8")
    config = {"host": args.host, "username": args.username, "port": args.port,
              "identityFile": str(identity), "knownHostsFile": str(hosts)}
    target = args.data_dir.resolve() / "docker-sandbox.json"
    target.write_text(json.dumps(config, indent=2) + "\n", encoding="utf8")
    target.chmod(0o600)
    stdin, stdout, stderr = client.exec_command("python3 " + shlex.quote(gateway), timeout=45)
    stdin.write('{"action":"health"}')
    stdin.channel.shutdown_write()
    result = json.loads(stdout.read())
    if "error" in result: raise RuntimeError(result["error"])
    fingerprint = base64.b64encode(hashlib.sha256(host_key.asbytes()).digest()).decode().rstrip("=")
    print(json.dumps({"config": str(target), "hostFingerprint": "SHA256:" + fingerprint, **result["result"]}, indent=2))
finally:
    client.close()
