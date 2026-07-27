import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import { ensureDataDirs, DATA_DIR, UPLOADS_DIR } from "./env.js";
import { Hub } from "./hub.js";
import {
  createInvite,
  getAdminRegistrationState,
  getPublicRegistrationPolicy,
  initAuth,
  issueToken,
  listUsers,
  registerUser,
  revokeInvite,
  setInviteRequired,
  setUserRole,
  verifyToken,
  verifyUser,
} from "./auth.js";
import { closeDb, initDb } from "./db.js";
import { store } from "./store.js";
import { uploadDirectory, uploadUsage } from "./uploads.js";
import { getSharedThreadAccess, initThreadShares } from "./threadShares.js";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "0.0.0.0";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIST = path.resolve(__dirname, "../../web/dist");
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
const MAX_USER_UPLOADS_SIZE = 200 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

function hasImageSignature(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "image/jpeg") return buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (mimeType === "image/png") return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/gif") {
    const signature = buffer.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mimeType === "image/webp") {
    return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

function authenticate(header: string | undefined) {
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  return token ? verifyToken(token) : null;
}

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
  await initThreadShares();
  console.log(`[cca] data dir: ${DATA_DIR}`);

  const app = Fastify({ logger: false });
  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);
  app.addContentTypeParser(
    Object.keys(IMAGE_EXTENSIONS),
    { parseAs: "buffer", bodyLimit: MAX_IMAGE_SIZE },
    (_req, body, done) => done(null, body),
  );

  const hub = new Hub();

  app.get("/health", async () => ({ ok: true }));

  app.get("/api/auth/registration", async () => getPublicRegistrationPolicy());

  app.post("/api/auth/register", async (req, reply) => {
    const body = (req.body ?? {}) as { username?: string; password?: string; inviteCode?: string };
    if (!body.username || !body.password) {
      return reply.code(400).send({ error: "用户名和密码必填" });
    }
    try {
      const user = registerUser(body.username, body.password, body.inviteCode);
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
    const payload = authenticate(req.headers.authorization);
    if (!payload) {
      return reply.code(401).send({ error: "未授权" });
    }
    return { user: { username: payload.username, role: payload.role } };
  });

  app.get("/api/admin/users", async (req, reply) => {
    const actor = authenticate(req.headers.authorization);
    if (!actor) return reply.code(401).send({ error: "未授权" });
    if (actor.role !== "admin") return reply.code(403).send({ error: "仅管理员可以执行此操作" });
    return listUsers();
  });

  app.patch("/api/admin/users/:username/role", async (req, reply) => {
    const actor = authenticate(req.headers.authorization);
    if (!actor) return reply.code(401).send({ error: "未授权" });
    if (actor.role !== "admin") return reply.code(403).send({ error: "仅管理员可以执行此操作" });
    const { username } = req.params as { username: string };
    const { role } = (req.body ?? {}) as { role?: "admin" | "user" };
    if (role !== "admin" && role !== "user") {
      return reply.code(400).send({ error: "用户角色无效" });
    }
    try {
      const user = setUserRole(actor.username, username, role);
      hub.updateUserRole(user.username, user.role);
      return user;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "修改角色失败" });
    }
  });

  app.get("/api/admin/registration", async (req, reply) => {
    const actor = authenticate(req.headers.authorization);
    if (!actor) return reply.code(401).send({ error: "未授权" });
    if (actor.role !== "admin") return reply.code(403).send({ error: "仅管理员可以执行此操作" });
    return getAdminRegistrationState();
  });

  app.put("/api/admin/registration", async (req, reply) => {
    const actor = authenticate(req.headers.authorization);
    if (!actor) return reply.code(401).send({ error: "未授权" });
    if (actor.role !== "admin") return reply.code(403).send({ error: "仅管理员可以执行此操作" });
    const { inviteRequired } = (req.body ?? {}) as { inviteRequired?: boolean };
    if (typeof inviteRequired !== "boolean") {
      return reply.code(400).send({ error: "邀请码设置无效" });
    }
    setInviteRequired(inviteRequired);
    return getAdminRegistrationState();
  });

  app.post("/api/admin/invites", async (req, reply) => {
    const actor = authenticate(req.headers.authorization);
    if (!actor) return reply.code(401).send({ error: "未授权" });
    if (actor.role !== "admin") return reply.code(403).send({ error: "仅管理员可以执行此操作" });
    return createInvite(actor.username);
  });

  app.delete("/api/admin/invites/:id", async (req, reply) => {
    const actor = authenticate(req.headers.authorization);
    if (!actor) return reply.code(401).send({ error: "未授权" });
    if (actor.role !== "admin") return reply.code(403).send({ error: "仅管理员可以执行此操作" });
    const { id } = req.params as { id: string };
    try {
      revokeInvite(id);
      return reply.code(204).send();
    } catch (error) {
      return reply.code(404).send({ error: error instanceof Error ? error.message : "邀请码不存在" });
    }
  });

  app.post("/api/uploads/images", async (req, reply) => {
    const payload = authenticate(req.headers.authorization);
    if (!payload) return reply.code(401).send({ error: "未授权" });

    const mimeType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    const extension = IMAGE_EXTENSIONS[mimeType];
    if (!extension) return reply.code(415).send({ error: "仅支持 JPG、PNG、GIF 和 WebP 图片" });
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return reply.code(400).send({ error: "图片内容为空" });
    }
    if (!hasImageSignature(req.body, mimeType)) {
      return reply.code(415).send({ error: "图片内容与文件类型不匹配" });
    }

    const rawName = req.headers["x-file-name"];
    let displayName = "图片" + extension;
    if (typeof rawName === "string") {
      try {
        displayName = path.basename(decodeURIComponent(rawName)).slice(0, 200) || displayName;
      } catch {
        return reply.code(400).send({ error: "图片文件名无效" });
      }
    }
    const userDirectory = uploadDirectory(payload.username);
    fs.mkdirSync(userDirectory, { recursive: true });
    if (uploadUsage(userDirectory) + req.body.length > MAX_USER_UPLOADS_SIZE) {
      return reply.code(413).send({ error: "图片存储已达到 200 MB 上限，请删除旧会话后重试" });
    }
    const id = `${randomUUID()}${extension}`;
    const imagePath = path.join(userDirectory, id);
    fs.writeFileSync(imagePath, req.body, { mode: 0o600 });
    return { id, path: imagePath, displayName };
  });

  app.get("/api/uploads/images/:id", async (req, reply) => {
    const payload = authenticate(req.headers.authorization);
    if (!payload) return reply.code(401).send({ error: "未授权" });

    const { id } = req.params as { id: string };
    const { threadId } = req.query as { threadId?: string };
    if (!/^[0-9a-f-]+\.(?:jpg|png|gif|webp)$/.test(id)) {
      return reply.code(400).send({ error: "图片标识无效" });
    }
    if (!threadId) return reply.code(400).send({ error: "缺少会话标识" });
    const thread = store.getThread(threadId);
    const canAccess = thread && (
      payload.role === "admin" ||
      !thread.userId ||
      thread.userId === payload.username ||
      getSharedThreadAccess(threadId, payload.username) !== null
    );
    if (!canAccess) return reply.code(403).send({ error: "无权访问该图片" });
    const attachment = Object.values(thread.messageAttachments ?? {}).flat().find((item) => item.id === id);
    if (!attachment) return reply.code(404).send({ error: "图片不存在" });
    const imagePath = path.join(uploadDirectory(attachment.ownerId || thread.userId || ""), id);
    if (!fs.existsSync(imagePath)) return reply.code(404).send({ error: "图片不存在" });
    const extension = path.extname(id);
    const mimeType = extension === ".jpg" ? "image/jpeg" : `image/${extension.slice(1)}`;
    return reply.type(mimeType).send(fs.createReadStream(imagePath));
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
  hub.warmupPlugins();

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await hub.shutdown();
      await app.close();
      await closeDb();
    } catch (err) {
      console.error("[cca] shutdown failed", err);
      process.exitCode = 1;
    } finally {
      process.exit();
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
