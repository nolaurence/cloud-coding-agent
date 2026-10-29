export const INLINE_OVERVIEW_INSET = 16;

export function inlineOverviewWidth(conversationWidth: number): number | null {
  if (!Number.isFinite(conversationWidth) || conversationWidth <= 0) return null;
  const composerWidth = Math.min(conversationWidth, Math.min(920, Math.max(680, conversationWidth * 0.64)) + 64);
  const gutter = (conversationWidth - composerWidth) / 2;
  const width = Math.min(300, Math.floor(gutter - INLINE_OVERVIEW_INSET - 16));
  return width >= 260 ? width : null;
}
