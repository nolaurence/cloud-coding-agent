FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/protocol/package.json packages/protocol/
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build -w @cca/web

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8787
ENV CCA_DATA_DIR=/data
COPY --from=build /app /app
RUN mkdir -p /data
EXPOSE 8787
VOLUME ["/data"]
CMD ["npm", "run", "start", "-w", "@cca/server"]
