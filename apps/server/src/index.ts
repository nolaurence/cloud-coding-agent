import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import { ensureDataDirs, DATA_DIR } from "./env.js";
import { Hub } from "./hub.js";
import { initAuth, issueToken, registerUser, verifyToken, verifyUser } from "./auth.js";
import { initDb } from "./db.js";
import { store } from "./store.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.resolve(__dirname, "../../web/dist");

async function main() {
  ensureDataDirs();
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    await initDb(databaseUrl);
  } else {
    console.log("[cca] DATABASE_URL 未设置,使用 JSON 文件存储");
  }
  await store.init();
  await initAuth();
  console.log(`[cca] data dir: ${DATA_DIR}`);

  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  const hub = new Hub();

  app.get("/health", async () => ({ ok: true }));

  app.post("/api/auth/register", async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string };
    if (!body.username || !body.password) {
      return reply.code(400).send({ error: "用户名和密码必填" });
    }
    try {
      const user = registerUser(body.username, body.password);
      return { token: issueToken(user), user: { username: user.username, role: user.role } };
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "注册失败" });
    }
  });

  app.post("/api/auth/login", async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string };
    if (!body.username || !body.password) {
      return reply.code(400).send({ error: "用户名和密码必填" });
    }
    const user = verifyUser(body.username, body.password);
    if (!user) {
      return reply.code(401).send({ error: "用户名或密码错误" });
    }
    return { token: issueToken(user), user: { username: user.username, role: user.role } };
  });

  app.get("/api/auth/me", async (req, reply) => {
    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    const payload = token ? verifyToken(token) : null;
    if (!payload) {
      return reply.code(401).send({ error: "未授权" });
    }
    return { user: { username: payload.username, role: payload.role } };
  });

  app.register(async (scope) => {
    scope.get("/ws", { websocket: true }, (socket, req) => {
      const query = req.query as { token?: string };
      hub.handleConnection(socket, query.token);
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
