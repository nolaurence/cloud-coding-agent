import type { FastifyInstance } from "fastify";
import { projectImageContentType, type AuthUser } from "@cca/protocol";
import { downloadDisposition } from "./fileDownloads.js";
import { store } from "./store.js";
import { openProjectFileDownload } from "./workspace.js";

const MAX_IMAGE_PREVIEW_SIZE = 32 * 1024 * 1024;

export function registerProjectFileRoutes(
  app: FastifyInstance,
  authenticate: (header: string | undefined) => AuthUser | null,
) {
  app.get("/api/projects/:projectId/files/download", async (req, reply) => {
    const user = authenticate(req.headers.authorization);
    if (!user) return reply.code(401).send({ error: "未授权" });
    const { projectId } = req.params as { projectId: string };
    const project = store.projects.find((candidate) => candidate.id === projectId);
    if (!project || project.ownerId !== user.username) {
      return reply.code(403).send({ error: "工作区不存在或无权访问" });
    }
    const { path } = req.query as { path?: unknown };
    if (typeof path !== "string" || !path) return reply.code(400).send({ error: "文件路径无效" });
    try {
      const file = openProjectFileDownload(project.path, path);
      return reply
        .header("Content-Disposition", downloadDisposition(file.name))
        .header("Content-Length", file.size)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .type("application/octet-stream")
        .send(file.stream);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return reply.code(404).send({ error: "文件不存在" });
      if (code === "EACCES" || code === "EPERM") return reply.code(403).send({ error: "无权读取该文件" });
      if (code) throw error;
      return reply.code(400).send({ error: error instanceof Error ? error.message : "文件下载失败" });
    }
  });

  app.get("/api/projects/:projectId/files/preview", async (req, reply) => {
    const user = authenticate(req.headers.authorization);
    if (!user) return reply.code(401).send({ error: "未授权" });
    const { projectId } = req.params as { projectId: string };
    const project = store.projects.find((candidate) => candidate.id === projectId);
    if (!project || project.ownerId !== user.username) {
      return reply.code(403).send({ error: "工作区不存在或无权访问" });
    }
    const { path } = req.query as { path?: unknown };
    if (typeof path !== "string" || !path) return reply.code(400).send({ error: "文件路径无效" });
    const contentType = projectImageContentType(path);
    if (!contentType) return reply.code(415).send({ error: "仅支持预览 PNG、JPEG、GIF、WebP、BMP、AVIF 和 ICO 图片" });
    try {
      const file = openProjectFileDownload(project.path, path, MAX_IMAGE_PREVIEW_SIZE);
      return reply
        .header("Content-Disposition", "inline")
        .header("Content-Length", file.size)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .type(contentType)
        .send(file.stream);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return reply.code(404).send({ error: "文件不存在" });
      if (code === "EACCES" || code === "EPERM") return reply.code(403).send({ error: "无权读取该文件" });
      if (code === "EFBIG") return reply.code(413).send({ error: error instanceof Error ? error.message : "图片过大，无法预览" });
      if (code) throw error;
      return reply.code(400).send({ error: error instanceof Error ? error.message : "图片读取失败" });
    }
  });
}
