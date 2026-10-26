// Keep user-controlled names and paths inside a JSON value with escaped markup delimiters.
export function attachmentReferenceText(displayName: string | undefined, filePath?: string): string {
  const reference = JSON.stringify({
    displayName: displayName ?? "附件",
    ...(filePath !== undefined ? { path: filePath } : {}),
  }).replace(/[<>&]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `\n<attachment>${reference}</attachment>`;
}

export function isAttachmentReferenceText(value: string): boolean {
  if (!value.startsWith("\n<attachment>") || !value.endsWith("</attachment>")) return false;
  try {
    const reference: unknown = JSON.parse(value.slice("\n<attachment>".length, -"</attachment>".length));
    if (!reference || typeof reference !== "object") return false;
    const { displayName, path: filePath } = reference as { displayName?: unknown; path?: unknown };
    return typeof displayName === "string" && (filePath === undefined || typeof filePath === "string") &&
      attachmentReferenceText(displayName, filePath) === value;
  } catch {
    return false;
  }
}
