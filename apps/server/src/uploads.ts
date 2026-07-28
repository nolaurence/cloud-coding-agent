import fs from "node:fs";
import path from "node:path";
import type { ThreadMeta, TurnAttachment } from "@cca/protocol";
import { UPLOADS_DIR } from "./env.js";

const IMAGE_ID_PATTERN = /^[0-9a-f-]+\.(?:jpg|png|gif|webp)$/;

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
  const workspaceRoot = fs.realpathSync(projectPath);
  for (const attachment of attachments ?? []) {
    if (attachment.imageId) {
      if (!IMAGE_ID_PATTERN.test(attachment.imageId)) throw new Error("图片标识无效");
      const expectedPath = path.join(uploadRoot, attachment.imageId);
      if (path.resolve(attachment.path) !== expectedPath || !fs.existsSync(expectedPath)) {
        throw new Error("图片不存在或不属于当前用户");
      }
      continue;
    }
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
