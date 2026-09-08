import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ThreadMeta, TurnAttachment } from "@cca/protocol";
import { UPLOADS_DIR } from "./env.js";

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
export const MAX_USER_UPLOADS_SIZE = 200 * 1024 * 1024;
export const IMAGE_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
} as const;

const IMAGE_ID_PATTERN = /^[0-9a-f-]+\.(?:jpg|png|gif|webp)$/;

export class ImageUploadError extends Error {
  constructor(
    readonly statusCode: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = "ImageUploadError";
  }
}

export function hasImageSignature(buffer: Buffer, mimeType: string): boolean {
  if (mimeType === "image/jpeg") {
    return buffer.length >= 3 && buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  }
  if (mimeType === "image/png") {
    return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === "image/gif") {
    const signature = buffer.subarray(0, 6).toString("ascii");
    return signature === "GIF87a" || signature === "GIF89a";
  }
  if (mimeType === "image/webp") {
    return buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  }
  return false;
}

export function uploadDirectory(username: string) {
  return path.join(UPLOADS_DIR, encodeURIComponent(username));
}

export function uploadUsage(directory: string): number {
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    if (!entry.isFile()) return total;
    return total + fs.statSync(path.join(directory, entry.name)).size;
  }, 0);
}

export function storeUploadedImage(
  username: string,
  buffer: Buffer,
  mimeType: string,
  displayName: string,
): TurnAttachment & { imageId: string } {
  const normalizedMimeType = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const extension = IMAGE_EXTENSIONS[normalizedMimeType as keyof typeof IMAGE_EXTENSIONS];
  if (!extension) throw new ImageUploadError(415, "仅支持 JPG、PNG、GIF 和 WebP 图片");
  if (buffer.length === 0) throw new ImageUploadError(400, "图片内容为空");
  if (buffer.length > MAX_IMAGE_SIZE) throw new ImageUploadError(413, "单张图片不能超过 10 MB");
  if (!hasImageSignature(buffer, normalizedMimeType)) {
    throw new ImageUploadError(415, "图片内容与文件类型不匹配");
  }

  const directory = uploadDirectory(username);
  fs.mkdirSync(directory, { recursive: true });
  if (uploadUsage(directory) + buffer.length > MAX_USER_UPLOADS_SIZE) {
    throw new ImageUploadError(413, "图片存储已达到 200 MB 上限，请删除旧会话后重试");
  }

  const imageId = randomUUID() + extension;
  const imagePath = path.join(directory, imageId);
  fs.writeFileSync(imagePath, buffer, { mode: 0o600 });
  return {
    imageId,
    path: imagePath,
    displayName: path.basename(displayName).slice(0, 200) || "图片" + extension,
  };
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" ||
    (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

export function validateTurnAttachments(
  username: string,
  projectPath: string,
  attachments?: TurnAttachment[],
) {
  const uploadRoot = uploadDirectory(username);
  let workspaceRoot: string | undefined;
  for (const attachment of attachments ?? []) {
    if (attachment.imageId) {
      if (!IMAGE_ID_PATTERN.test(attachment.imageId)) throw new Error("图片标识无效");
      const expectedPath = path.join(uploadRoot, attachment.imageId);
      if (path.resolve(attachment.path) !== expectedPath || !fs.existsSync(expectedPath)) {
        throw new Error("图片不存在或不属于当前用户");
      }
      continue;
    }
    workspaceRoot ??= fs.realpathSync(projectPath);
    let realAttachment: string;
    try {
      realAttachment = fs.realpathSync(path.resolve(workspaceRoot, attachment.path));
    } catch {
      throw new Error("附件不存在或不属于当前工作区");
    }
    if (!isInside(workspaceRoot, realAttachment) || !fs.statSync(realAttachment).isFile()) {
      throw new Error("附件不存在或不属于当前工作区");
    }
    attachment.path = realAttachment;
  }
}

export function removeUploadedImages(username: string, attachments?: TurnAttachment[]) {
  const directory = uploadDirectory(username);
  for (const attachment of attachments ?? []) {
    if (!attachment.imageId || !IMAGE_ID_PATTERN.test(attachment.imageId)) continue;
    fs.rmSync(path.join(directory, attachment.imageId), { force: true });
  }
}

export function removeThreadUploads(thread: ThreadMeta) {
  for (const attachment of Object.values(thread.messageAttachments ?? {}).flat()) {
    if (!IMAGE_ID_PATTERN.test(attachment.id)) continue;
    fs.rmSync(path.join(uploadDirectory(attachment.ownerId || thread.userId || ""), attachment.id), {
      force: true,
    });
  }
}
