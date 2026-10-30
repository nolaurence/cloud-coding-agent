import type { TurnAttachment } from "@cca/protocol";
import { create } from "zustand";
import { discardUpload, uploadFile, uploadImage } from "./client.js";

export const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
export const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
export const MAX_FILE_SIZE = 20 * 1024 * 1024;

export interface ComposerAttachment {
  id: string;
  file: File;
  kind: "image" | "file";
  previewUrl?: string;
  status: "uploading" | "ready" | "error";
  error?: string;
  uploaded?: TurnAttachment;
  attempt: number;
}

const EMPTY_ATTACHMENTS: ComposerAttachment[] = [];
let nextAttachmentId = 0;

// Browser files and object URLs stay in memory with the draft when switching sessions.
const useAttachmentStore = create<{ drafts: Record<string, ComposerAttachment[]> }>(() => ({ drafts: {} }));

function attachmentsFor(draftKey: string): ComposerAttachment[] {
  return useAttachmentStore.getState().drafts[draftKey] ?? EMPTY_ATTACHMENTS;
}

function updateAttachments(draftKey: string, update: (items: ComposerAttachment[]) => ComposerAttachment[]) {
  useAttachmentStore.setState((state) => {
    const drafts = { ...state.drafts };
    const next = update(drafts[draftKey] ?? EMPTY_ATTACHMENTS);
    if (next.length > 0) drafts[draftKey] = next;
    else delete drafts[draftKey];
    return { drafts };
  });
}

function discard(uploaded: TurnAttachment | undefined) {
  if (uploaded) void discardUpload(uploaded).catch(() => {});
}

async function upload(draftKey: string, id: string) {
  const item = attachmentsFor(draftKey).find((candidate) => candidate.id === id);
  if (!item) return;
  const attempt = item.attempt + 1;
  updateAttachments(draftKey, (items) => items.map((candidate) => candidate.id === id
    ? { ...candidate, attempt, status: "uploading", error: undefined, uploaded: undefined }
    : candidate));
  try {
    const uploaded = await (item.kind === "image" ? uploadImage(item.file) : uploadFile(item.file));
    const current = attachmentsFor(draftKey).find((candidate) => candidate.id === id);
    if (!current || current.attempt !== attempt) {
      discard(uploaded);
      return;
    }
    updateAttachments(draftKey, (items) => items.map((candidate) => candidate.id === id
      ? { ...candidate, status: "ready", uploaded }
      : candidate));
  } catch (error) {
    updateAttachments(draftKey, (items) => items.map((candidate) => candidate.id === id && candidate.attempt === attempt
      ? { ...candidate, status: "error", error: error instanceof Error ? error.message : "附件上传失败" }
      : candidate));
  }
}

export function fileSizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function useComposerAttachments(draftKey: string) {
  const attachments = useAttachmentStore((state) => state.drafts[draftKey] ?? EMPTY_ATTACHMENTS);

  const addFiles = (files: Iterable<File>): string => {
    const added: ComposerAttachment[] = [];
    const errors: string[] = [];
    for (const input of files) {
      const extension = input.name.split(".").pop()?.toLowerCase();
      const imageType = extension && ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" } as Record<string, string>)[extension];
      const file = imageType && !ACCEPTED_IMAGE_TYPES.has(input.type)
        ? new File([input], input.name, { type: imageType, lastModified: input.lastModified })
        : input;
      const kind = ACCEPTED_IMAGE_TYPES.has(file.type) ? "image" : "file";
      if (file.size === 0) {
        errors.push(`${file.name} 内容为空`);
        continue;
      }
      const limit = kind === "image" ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;
      if (file.size > limit) {
        errors.push(`${file.name} 超过 ${limit / (1024 * 1024)} MB`);
        continue;
      }
      added.push({
        id: `attachment-${++nextAttachmentId}`,
        file,
        kind,
        previewUrl: kind === "image" ? URL.createObjectURL(file) : undefined,
        status: "uploading",
        attempt: 0,
      });
    }
    if (added.length > 0) {
      updateAttachments(draftKey, (items) => [...items, ...added]);
      for (const item of added) void upload(draftKey, item.id);
    }
    return [...new Set(errors)].join("；");
  };

  const removeAttachment = (id: string) => {
    const removed = attachmentsFor(draftKey).find((item) => item.id === id);
    updateAttachments(draftKey, (items) => items.filter((item) => item.id !== id));
    if (removed?.previewUrl) URL.revokeObjectURL(removed.previewUrl);
    discard(removed?.uploaded);
  };

  const clearSentAttachments = (sent: readonly ComposerAttachment[]) => {
    const ids = new Set(sent.map((item) => item.id));
    updateAttachments(draftKey, (items) => items.filter((item) => !ids.has(item.id)));
    sent.forEach((item) => { if (item.previewUrl) URL.revokeObjectURL(item.previewUrl); });
  };

  const invalidateAttachments = (sent: readonly ComposerAttachment[]) => {
    const ids = new Set(sent.map((item) => item.id));
    updateAttachments(draftKey, (items) => items.map((item) => ids.has(item.id)
      ? { ...item, status: "error", uploaded: undefined, error: "发送未成功，请点击重试上传" }
      : item));
    sent.forEach((item) => discard(item.uploaded));
  };

  return {
    attachments,
    addFiles,
    removeAttachment,
    retryAttachment: (id: string) => { void upload(draftKey, id); },
    clearSentAttachments,
    invalidateAttachments,
  };
}
