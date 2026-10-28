import fs from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AuthUser } from "@cca/protocol";
import { store } from "./store.js";
import { getThreadAccess } from "./threadAccess.js";
import { validateThreadShareToken } from "./threadShares.js";
import {
  IMAGE_EXTENSIONS,
  MAX_FILE_SIZE,
  MAX_IMAGE_SIZE,
  UploadError,
  isUploadId,
  isUploadReferenced,
  removeUploadedAttachments,
  storedUploadPath,
  storeUploadedFile,
  storeUploadedImage,
} from "./uploads.js";

type Authenticate = (header: string | undefined) => AuthUser | null;

function downloadDisposition(name: string): string {
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (character) =>
    "%" + character.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="download"; filename*=UTF-8''${encoded}`;
}

export function registerUploadRoutes(app: FastifyInstance, authenticate: Authenticate) {
  app.addContentTypeParser(Object.keys(IMAGE_EXTENSIONS),
    { parseAs: "buffer", bodyLimit: MAX_IMAGE_SIZE }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("application/octet-stream",
    { parseAs: "buffer", bodyLimit: MAX_FILE_SIZE }, (_req, body, done) => done(null, body));

  for (const kind of ["image", "file"] as const) {
    const route = `/api/uploads/${kind}s`;
    const noun = kind === "image" ? "图片" : "文件";
    app.post(route, { bodyLimit: kind === "image" ? MAX_IMAGE_SIZE : MAX_FILE_SIZE }, async (req, reply) => {
      const user = authenticate(req.headers.authorization);
      if (!user) return reply.code(401).send({ error: "未授权" });
      const mimeType = req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      const extension = IMAGE_EXTENSIONS[mimeType as keyof typeof IMAGE_EXTENSIONS];
      if (kind === "image" ? !extension : mimeType !== "application/octet-stream") {
        return reply.code(415).send({ error: kind === "image" ? "仅支持 JPG、PNG、GIF 和 WebP 图片" : "文件上传需要 application/octet-stream" });
      }
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return reply.code(400).send({ error: `${noun}内容为空` });
      }
      const rawName = req.headers["x-file-name"];
      let displayName = noun + (extension ?? "");
      if (kind === "file" && (typeof rawName !== "string" || !rawName.trim())) {
        return reply.code(400).send({ error: "缺少文件名" });
      }
      if (typeof rawName === "string") {
        try {
          displayName = decodeURIComponent(rawName);
        } catch {
          return reply.code(400).send({ error: `${noun}文件名无效` });
        }
      }
      try {
        const attachment = kind === "image"
          ? storeUploadedImage(user.username, req.body, mimeType, displayName)
          : storeUploadedFile(user.username, req.body, displayName);
        return { id: attachment.imageId ?? attachment.fileId, path: attachment.path, displayName: attachment.displayName };
      } catch (error) {
        if (error instanceof UploadError) return reply.code(error.statusCode).send({ error: error.message });
        throw error;
      }
    });

    app.get(`${route}/:id`, async (req, reply) => {
      const user = authenticate(req.headers.authorization);
      if (!user) return reply.code(401).send({ error: "未授权" });
      const { id } = req.params as { id: string };
      const { threadId, shareToken: queryToken } = req.query as { threadId?: string; shareToken?: string };
      if (!isUploadId(id, kind)) return reply.code(400).send({ error: `${noun}标识无效` });
      if (!threadId) return reply.code(400).send({ error: "缺少会话标识" });
      const thread = store.getThread(threadId);
      const rawShareToken = req.headers["x-thread-share-token"];
      const shareToken = typeof rawShareToken === "string" ? rawShareToken : queryToken;
      if (!thread || (getThreadAccess(user, thread) === null && validateThreadShareToken(threadId, shareToken) === null)) {
        return reply.code(403).send({ error: `无权访问该${noun}` });
      }
      const attachment = Object.values(thread.messageAttachments ?? {}).flat()
        .find((item) => item.id === id && item.kind === kind);
      if (!attachment) return reply.code(404).send({ error: `${noun}不存在` });
      let filePath: string;
      try {
        filePath = storedUploadPath(attachment.ownerId || thread.userId || "", id, kind);
      } catch {
        return reply.code(404).send({ error: `${noun}不存在` });
      }
      if (kind === "file") {
        reply.header("Content-Disposition", downloadDisposition(attachment.displayName));
        reply.header("X-Content-Type-Options", "nosniff");
        return reply.type("application/octet-stream").send(fs.createReadStream(filePath));
      }
      const extension = path.extname(id);
      return reply.type(extension === ".jpg" ? "image/jpeg" : `image/${extension.slice(1)}`)
        .send(fs.createReadStream(filePath));
    });

    app.delete(`${route}/:id`, async (req, reply) => {
      const user = authenticate(req.headers.authorization);
      if (!user) return reply.code(401).send({ error: "未授权" });
      const { id } = req.params as { id: string };
      if (!isUploadId(id, kind)) return reply.code(400).send({ error: `${noun}标识无效` });
      try {
        storedUploadPath(user.username, id, kind);
      } catch {
        return reply.code(404).send({ error: `${noun}不存在` });
      }
      if (isUploadReferenced(user.username, id, store.threads)) {
        return reply.code(409).send({ error: `${noun}已被会话使用` });
      }
      removeUploadedAttachments(user.username, [{ path: "", ...(kind === "image" ? { imageId: id } : { fileId: id }) }]);
      return reply.code(204).send();
    });
  }
}
