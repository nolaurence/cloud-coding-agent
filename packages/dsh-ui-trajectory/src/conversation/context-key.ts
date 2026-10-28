/** Stable Definition-local key used by the vendored conversation assembler. */
export function conversationContextKey(kind: string, id: string): string {
  return `${kind.length}:${kind}${id}`
}
