FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY apps/desktop/package.json apps/desktop/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
RUN ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY apps/desktop/build-server.mjs ./apps/desktop/build-server.mjs
COPY apps/server ./apps/server
COPY apps/web ./apps/web
COPY packages/protocol ./packages/protocol
COPY deploy ./deploy
RUN npm run build -w @cca/web \
    && npm run build -w @cca/server

FROM node:22-slim
WORKDIR /opt/cca-dsh
ENV NODE_ENV=production
ENV PORT=8787
ENV CCA_DATA_DIR=/data
# Mounted repositories can have a host UID that differs from the container.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates chromium fonts-noto-cjk git openssh-client novnc ripgrep rsync websockify x11vnc xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /opt/cca-dsh/helper \
    && git config --system --add safe.directory '*'

# DeepSeek Harness and its profile plugins are installed at image build time so
# container startup never needs network access. DSH must own this profile's
# pnpm workspace: pnpm supplies the peer closure that a plain npm install omits,
# leaving core services such as sessionController unavailable.
COPY deploy/dsh/install-runtime.sh deploy/dsh/patch-helper.mjs ./
RUN sh ./install-runtime.sh

# Add the completed application after all package-manager operations. Later
# layers must not rewrite /app/node_modules or its .bin directory.
WORKDIR /app
COPY --from=build /app /app

ENV DSH_HOME=/data/dsh-home-cca
ENV DSH_PROFILE_TEMPLATE=/opt/cca-dsh/profile-template
ENV DSH_SSH_HELPER=/home/nolaurence/cca-dsh/helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js
ENV DSH_SSH_HELPER_LOCAL=/opt/cca-dsh/helper/node_modules/@deepseek-ai/dsh-ssh/lib/helper.js
ENV DSH_SSH_TMPDIR=/tmp/cca-dsh-sockets
ENV DSH_PERMISSION_MODE=danger-full-access
ENV DSH_TELEMETRY_DISABLED=1
EXPOSE 8787
VOLUME ["/data"]
CMD ["npm", "run", "start", "-w", "@cca/server"]
