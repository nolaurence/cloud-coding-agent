export type ComposerDrafts = Record<string, string>;

export const NEW_CHAT_DRAFT_KEY = "new-chat";

export function threadComposerDraftKey(threadId: string): string {
  return `thread:${threadId}`;
}

export function updateComposerDraft(
  drafts: ComposerDrafts,
  key: string,
  text: string,
): ComposerDrafts {
  if (text) return { ...drafts, [key]: text };
  if (!(key in drafts)) return drafts;

  const next = { ...drafts };
  delete next[key];
  return next;
}

export function clearComposerDraft(
  drafts: ComposerDrafts,
  key: string,
  expectedText: string,
): ComposerDrafts {
  if (drafts[key] !== expectedText) return drafts;
  return updateComposerDraft(drafts, key, "");
}

export function buildFileMentionPayload(text: string) {
  const paths = new Set<string>();
  const prompt = text.replace(/(^|\s)@\[([^\]\r\n]+)\]/g, (_match, prefix: string, file: string) => {
    paths.add(file);
    return prefix + "`" + file + "`";
  });
  return { prompt, attachments: [...paths].map((path) => ({ path, displayName: path })) };
}
