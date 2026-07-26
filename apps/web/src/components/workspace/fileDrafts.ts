export interface FileDraft {
  content: string;
  baseVersion: string;
  error?: string;
  updatedAt: number;
}

const STORAGE_PREFIX = "cca:file-draft:v1:";
const STORAGE_WRITE_INTERVAL_MS = 200;

const drafts = new Map<string, FileDraft>();
const hydratedKeys = new Set<string>();
const pendingStorageWrites = new Set<string>();
let storageWriteTimer: ReturnType<typeof setTimeout> | null = null;

function draftKey(ownerId: string, projectId: string, path: string): string {
  return `${STORAGE_PREFIX}${JSON.stringify([ownerId, projectId, path])}`;
}

function copyDraft(draft: FileDraft): FileDraft {
  return {
    content: draft.content,
    baseVersion: draft.baseVersion,
    updatedAt: draft.updatedAt,
    ...(draft.error === undefined ? {} : { error: draft.error }),
  };
}

function isFileDraft(value: unknown): value is FileDraft {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FileDraft>;
  return typeof candidate.content === "string"
    && typeof candidate.baseVersion === "string"
    && (candidate.error === undefined || typeof candidate.error === "string")
    && typeof candidate.updatedAt === "number"
    && Number.isFinite(candidate.updatedAt)
    && candidate.updatedAt >= 0;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function writePendingKeys(keys: readonly string[]): void {
  const storage = getStorage();
  if (!storage) return;

  for (const key of keys) {
    const draft = drafts.get(key);
    if (!draft) {
      pendingStorageWrites.delete(key);
      continue;
    }
    try {
      storage.setItem(key, JSON.stringify(draft));
      pendingStorageWrites.delete(key);
    } catch {
      // Keep the in-memory draft and retry on the next explicit or scheduled flush.
    }
  }
}

function cancelStorageWriteTimer(): void {
  if (storageWriteTimer === null) return;
  clearTimeout(storageWriteTimer);
  storageWriteTimer = null;
}

function scheduleStorageWrite(): void {
  if (storageWriteTimer !== null) return;
  storageWriteTimer = setTimeout(() => {
    storageWriteTimer = null;
    writePendingKeys([...pendingStorageWrites]);
  }, STORAGE_WRITE_INTERVAL_MS);
}

export function getFileDraft(
  ownerId: string,
  projectId: string,
  path: string,
): FileDraft | null {
  const key = draftKey(ownerId, projectId, path);
  const cached = drafts.get(key);
  if (cached) return copyDraft(cached);
  if (hydratedKeys.has(key)) return null;

  hydratedKeys.add(key);
  const storage = getStorage();
  if (!storage) return null;

  try {
    const serialized = storage.getItem(key);
    if (serialized === null) return null;
    const parsed: unknown = JSON.parse(serialized);
    if (!isFileDraft(parsed)) {
      storage.removeItem(key);
      return null;
    }
    const draft = copyDraft(parsed);
    drafts.set(key, draft);
    return copyDraft(draft);
  } catch {
    return null;
  }
}

export function saveFileDraft(
  ownerId: string,
  projectId: string,
  path: string,
  draft: FileDraft,
): void {
  const key = draftKey(ownerId, projectId, path);
  drafts.set(key, copyDraft(draft));
  hydratedKeys.add(key);
  pendingStorageWrites.add(key);
  scheduleStorageWrite();
}

export function clearFileDraft(ownerId: string, projectId: string, path: string): void {
  const key = draftKey(ownerId, projectId, path);
  drafts.delete(key);
  pendingStorageWrites.delete(key);
  hydratedKeys.add(key);

  if (pendingStorageWrites.size === 0) cancelStorageWriteTimer();
  try {
    getStorage()?.removeItem(key);
  } catch {
    // The current session still treats the draft as cleared when storage is unavailable.
  }
}

export function flushFileDraft(): void;
export function flushFileDraft(ownerId: string, projectId: string, path: string): void;
export function flushFileDraft(ownerId?: string, projectId?: string, path?: string): void {
  if (ownerId === undefined || projectId === undefined || path === undefined) {
    cancelStorageWriteTimer();
    writePendingKeys([...pendingStorageWrites]);
    return;
  }

  const key = draftKey(ownerId, projectId, path);
  if (pendingStorageWrites.has(key)) writePendingKeys([key]);
  if (pendingStorageWrites.size === 0) cancelStorageWriteTimer();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => flushFileDraft());
}
