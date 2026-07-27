FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w @cca/web

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV CCA_DATA_DIR=/data
COPY --from=build /app /app
# Mounted repositories can have a host UID that differs from the container.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git openssh-client ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data \
    && git config --system --add safe.directory '*'
EXPOSE 8787
VOLUME ["/data"]
CMD ["npm", "run", "start", "-w", "@cca/server"]
