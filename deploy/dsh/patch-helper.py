#!/usr/bin/env python3
import pathlib
import sys

if len(sys.argv) != 2:
    raise SystemExit("用法: patch-helper.py <helper.js>")
path = pathlib.Path(sys.argv[1])
source = path.read_text()
needle = 'mkdtemp("/tmp/dsh-ssh-")'
legacy = 'mkdtemp(process.env.DSH_SSH_TMPDIR ?? "/tmp/dsh-ssh-")'
replacement = 'mkdtemp(join(process.env.DSH_SSH_TMPDIR ?? "/tmp", "dsh-ssh-"))'
if replacement in source:
    print("helper 已应用 DSH_SSH_TMPDIR 补丁")
    raise SystemExit(0)
if needle not in source and legacy not in source:
    raise SystemExit("未找到 helper 的 mkdtemp 调用，版本可能已变化")
path.write_text(source.replace(legacy, replacement) if legacy in source else source.replace(needle, replacement))
print("helper 已应用 DSH_SSH_TMPDIR 补丁")
