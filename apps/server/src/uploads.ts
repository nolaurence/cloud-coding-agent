import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MessageAttachment, ThreadMeta, TurnAttachment } from "@cca/protocol";
import { UPLOADS_DIR } from "./env.js";

export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
export const MAX_FILE_SIZE = 20 * 1024 * 1024;
export const MAX_USER_UPLOADS_SIZE = 200 * 1024 * 1024;
export const IMAGE_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
} as const;

const IMAGE_ID_PATTERN = /^[0-9a-f-]+\.(?:jpg|png|gif|webp)$/;
const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,16}$/;

export class UploadError extends Error {
  constructor(
    readonly statusCode: 400 | 413 | 415,
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

// Keep the existing image upload error API for callers that handle it separately.
export class ImageUploadError extends UploadError {
  constructor(statusCode: 400 | 413 | 415, message: string) {
    super(statusCode, message);
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
  if (!username || username === "." || username === "..") throw new Error("上传用户无效");
  return path.join(UPLOADS_DIR, encodeURIComponent(username));
}

export function uploadUsage(directory: string): number {
  if (!fs.existsSync(directory)) return 0;
  return fs.readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    if (!entry.isFile()) return total;
    return total + fs.statSync(path.join(directory, entry.name)).size;
  }, 0);
}

export function uploadDisplayName(name: string, fallback = "附件"): string {
  return name.replaceAll("\\", "/").split("/").pop()?.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200).trim() || fallback;
}

function prepareUploadDirectory(username: string, size: number): string {
  const directory = uploadDirectory(username);
  fs.mkdirSync(directory, { recursive: true });
  // Native realpath resolves Windows junctions as well as symbolic links.
  // Refuse user directories redirected to another account or outside the upload store.
  const expectedDirectory = path.join(fs.realpathSync.native(UPLOADS_DIR), encodeURIComponent(username));
  if (fs.realpathSync.native(directory) !== expectedDirectory) throw new UploadError(400, "上传目录无效");
  if (uploadUsage(directory) + size > MAX_USER_UPLOADS_SIZE) {
    throw new UploadError(413, "附件存储已达到 200 MB 上限，请删除旧会话后重试");
  }
  return directory;
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

  let directory: string;
  try {
    directory = prepareUploadDirectory(username, buffer.length);
  } catch (error) {
    if (error instanceof UploadError) throw new ImageUploadError(error.statusCode, error.message);
    throw error;
  }
  const imageId = randomUUID() + extension;
  const imagePath = path.join(directory, imageId);
  fs.writeFileSync(imagePath, buffer, { mode: 0o600, flag: "wx" });
  return { imageId, path: imagePath, displayName: uploadDisplayName(displayName, "图片" + extension) };
}

export function storeUploadedFile(
  username: string,
  buffer: Buffer,
  displayName: string,
): TurnAttachment & { fileId: string } {
  if (buffer.length === 0) throw new UploadError(400, "文件内容为空");
  if (buffer.length > MAX_FILE_SIZE) throw new UploadError(413, "单个文件不能超过 20 MB");
  const name = uploadDisplayName(displayName);
  const originalExtension = path.extname(name).toLowerCase();
  if (/^\.(?:jpe?g|png|gif|webp)$/.test(originalExtension) ||
    Object.keys(IMAGE_EXTENSIONS).some((mimeType) => hasImageSignature(buffer, mimeType))) {
    throw new UploadError(415, "图片请使用图片上传接口");
  }
  const extension = /^\.[a-z0-9]{1,16}$/.test(originalExtension) ? originalExtension : ".bin";
  const directory = prepareUploadDirectory(username, buffer.length);
  const fileId = randomUUID() + extension;
  const filePath = path.join(directory, fileId);
  fs.writeFileSync(filePath, buffer, { mode: 0o600, flag: "wx" });
  return { fileId, path: filePath, displayName: name };
}

export function isUploadId(id: unknown, kind: MessageAttachment["kind"]): id is string {
  return typeof id === "string" && (kind === "image" ? IMAGE_ID_PATTERN : FILE_ID_PATTERN).test(id);
}

export function storedUploadPath(username: string, id: string, kind: MessageAttachment["kind"]): string {
  if (!isUploadId(id, kind)) throw new Error(kind === "image" ? "图片标识无效" : "文件标识无效");
  const directory = uploadDirectory(username);
  const realDirectory = fs.realpathSync.native(directory);
  if (realDirectory !== path.join(fs.realpathSync.native(UPLOADS_DIR), encodeURIComponent(username))) {
    throw new Error("附件不存在或不属于当前用户");
  }
  const expectedPath = path.join(realDirectory, id);
  const realPath = fs.realpathSync.native(path.join(directory, id));
  if (realPath !== expectedPath || !fs.lstatSync(realPath).isFile()) {
    throw new Error("附件不存在或不属于当前用户");
  }
  return realPath;
}

export function readStoredImage(username: string, imageId: string): Buffer {
  return fs.readFileSync(storedUploadPath(username, imageId, "image"));
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
  if (attachments !== undefined && !Array.isArray(attachments)) throw new Error("附件格式无效");
  let workspaceRoot: string | undefined;
  for (const attachment of attachments ?? []) {
    if (!attachment || typeof attachment !== "object" || typeof attachment.path !== "string" ||
      (attachment.displayName !== undefined && typeof attachment.displayName !== "string")) {
      throw new Error("附件格式无效");
    }
    if (attachment.imageId !== undefined || attachment.fileId !== undefined) {
      if (attachment.imageId !== undefined && attachment.fileId !== undefined) throw new Error("附件标识无效");
      const kind = attachment.imageId !== undefined ? "image" : "file";
      const id = kind === "image" ? attachment.imageId : attachment.fileId;
      if (!isUploadId(id, kind)) throw new Error(kind === "image" ? "图片标识无效" : "文件标识无效");
      try {
        if (path.resolve(attachment.path) !== path.resolve(uploadDirectory(username), id)) throw new Error();
        attachment.path = storedUploadPath(username, id, kind);
      } catch {
        throw new Error("附件不存在或不属于当前用户");
      }
      continue;
    }
    workspaceRoot ??= fs.realpathSync.native(projectPath);
    let realAttachment: string;
    try {
      realAttachment = fs.realpathSync.native(path.resolve(workspaceRoot, attachment.path));
    } catch {
      throw new Error("附件不存在或不属于当前工作区");
    }
    if (!isInside(workspaceRoot, realAttachment) || !fs.statSync(realAttachment).isFile()) {
      throw new Error("附件不存在或不属于当前工作区");
    }
    attachment.path = realAttachment;
  }
}

function removeUpload(username: string, id: string, kind: MessageAttachment["kind"]) {
  if (!isUploadId(id, kind)) return;
  let target: string;
  try {
    target = storedUploadPath(username, id, kind);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fs.rmSync(target, { force: true });
}

export function isUploadReferenced(username: string, id: string, threads: readonly ThreadMeta[]) {
  return threads.some((thread) => Object.values(thread.messageAttachments ?? {}).some((items) =>
    items.some((attachment) => attachment.id === id && (attachment.ownerId || thread.userId) === username),
  ));
}

export function removeUploadedAttachments(username: string, attachments?: TurnAttachment[], retainedThreads: readonly ThreadMeta[] = []) {
  if (!Array.isArray(attachments)) return;
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") continue;
    if (attachment.imageId && !isUploadReferenced(username, attachment.imageId, retainedThreads)) {
      removeUpload(username, attachment.imageId, "image");
    }
    if (attachment.fileId && !isUploadReferenced(username, attachment.fileId, retainedThreads)) {
      removeUpload(username, attachment.fileId, "file");
    }
  }
}

/** Compatibility API: existing callers also clean up regular uploaded files. */
export function removeUploadedImages(username: string, attachments?: TurnAttachment[], retainedThreads: readonly ThreadMeta[] = []) {
  removeUploadedAttachments(username, attachments, retainedThreads);
}

export function removeThreadUploads(thread: ThreadMeta, retainedThreads: readonly ThreadMeta[] = []) {
  for (const attachment of Object.values(thread.messageAttachments ?? {}).flat()) {
    const ownerId = attachment.ownerId || thread.userId;
    if (ownerId && !isUploadReferenced(ownerId, attachment.id, retainedThreads)) {
      removeUpload(ownerId, attachment.id, attachment.kind);
    }
  }
}
