#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "用法: sandbox-install.sh <sandbox-public-key-file> [workspace-sync-public-key-file]" >&2
  exit 2
fi
PUBKEY_FILE="$1"
SYNC_PUBKEY_FILE="${2:-}"
[ -f "$PUBKEY_FILE" ] || { echo "沙箱公钥文件不存在: $PUBKEY_FILE" >&2; exit 2; }
PUBKEY="$(tr -d '\r\n' < "$PUBKEY_FILE")"
SYNC_PUBKEY=""
if [ -n "$SYNC_PUBKEY_FILE" ]; then
  [ -f "$SYNC_PUBKEY_FILE" ] || { echo "同步公钥文件不存在: $SYNC_PUBKEY_FILE" >&2; exit 2; }
  SYNC_PUBKEY="$(tr -d '\r\n' < "$SYNC_PUBKEY_FILE")"
  command -v rrsync >/dev/null 2>&1 || { echo "缺少 rrsync，无法配置工作区同步" >&2; exit 2; }
fi

BASE="$HOME/cca-dsh"
HELPER="$BASE/helper"
WORKSPACE_HOST="${CCA_DSH_WORKSPACE:-$HOME/cca-workspaces/default}"
mkdir -p "$HELPER" "$WORKSPACE_HOST" /tmp/cca-dsh-sockets
chmod 700 /tmp/cca-dsh-sockets

if [ ! -f "$HELPER/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js" ]; then
  if [ ! -f "$HELPER/package.json" ]; then
    npm init -y --prefix "$HELPER" >/dev/null
  fi
  npm install --prefix "$HELPER" --no-audit --no-fund "@deepseek-ai/dsh-ssh@0.2.1-rc.2"
fi

if command -v node >/dev/null 2>&1; then
  node "$(dirname "$0")/patch-helper.mjs" "$HELPER/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js"
else
  python3 "$(dirname "$0")/patch-helper.py" "$HELPER/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js"
fi
install -m 700 "$(dirname "$0")/dsh-ssh-gateway" "$BASE/dsh-ssh-gateway"

mkdir -p "$HOME/.ssh"
chmod 700 "$HOME/.ssh"
touch "$HOME/.ssh/authorized_keys"
chmod 600 "$HOME/.ssh/authorized_keys"
TMP_KEYS="$(mktemp)"
grep -vE 'cca-dsh-sandbox|cca-workspace-sync' "$HOME/.ssh/authorized_keys" > "$TMP_KEYS" || true
printf '%s %s\n' \
  'command="'"$BASE"'/dsh-ssh-gateway",no-agent-forwarding,no-X11-forwarding,no-pty' \
  "$PUBKEY cca-dsh-sandbox" >> "$TMP_KEYS"
if [ -n "$SYNC_PUBKEY" ]; then
  printf '%s %s\n' \
    'command="rrsync -wo '"$WORKSPACE_HOST"'",restrict' \
    "$SYNC_PUBKEY cca-workspace-sync" >> "$TMP_KEYS"
fi
cat "$TMP_KEYS" > "$HOME/.ssh/authorized_keys"
unlink "$TMP_KEYS"

HASH="$(sha256sum "$HELPER/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js" | awk '{print $1}')"
echo "CCA_DSH_HELPER=$HELPER/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js"
echo "CCA_DSH_HELPER_SHA256=$HASH"
echo "sandbox gateway installed"
