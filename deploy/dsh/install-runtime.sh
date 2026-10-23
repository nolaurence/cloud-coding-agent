#!/bin/sh
set -eu

# Shared by source and pipeline images. Keep package installation outside /app.
export DSH_HOME=/opt/cca-dsh/bootstrap-home
npm install -g --no-audit --no-fund pnpm@10.34.7 @deepseek-ai/dsh@0.2.1-rc.2
dsh plugin --profile web add \
  @deepseek-ai/dsh-ssh@0.2.1-rc.2 \
  @deepseek-ai/dsh-fs-ssh@0.2.1-rc.2 \
  @deepseek-ai/dsh-subprocess-ssh@0.2.1-rc.2 \
  @deepseek-ai/dsh-sandbox-ssh@0.2.1-rc.2 \
  @deepseek-ai/dsh-llm-pi-ai@0.2.1-rc.2

mkdir -p /opt/cca-dsh/helper
rm -rf /opt/cca-dsh/profile-template
cp -a "$DSH_HOME/profiles/web" /opt/cca-dsh/profile-template
cd /opt/cca-dsh/helper
npm init -y >/dev/null
npm install --no-audit --no-fund @deepseek-ai/dsh-ssh@0.2.1-rc.2
node /opt/cca-dsh/patch-helper.mjs /opt/cca-dsh/helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js
