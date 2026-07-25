import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import { ensureDataDirs, DATA_DIR } from "./env.js";
import { Hub } from "./hub.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.resolve(__dirname, "../../web/dist");

async function main() {
  ensureDataDirs();
  console.log(`[cca] data dir: ${DATA_DIR}`);

  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  const hub = new Hub();

  app.get("/health", async () => ({ ok: true }));

  app.register(async (scope) => {
    scope.get("/ws", { websocket: true }, (socket) => {
      hub.handleConnection(socket);
    });
  });

  if (fs.existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws")) {
        return reply.sendFile("index.html");
      }
      reply.code(404).send({ error: "not found" });
    });
  }

  await app.listen({ port: PORT, host: HOST });
  console.log(`[cca] server listening on http://${HOST}:${PORT}`);

  const shutdown = async () => {
    await hub.shutdown();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
