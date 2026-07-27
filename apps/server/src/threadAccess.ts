import type { AuthUser, ThreadAccess, ThreadMeta } from "@cca/protocol";
import { getSharedThreadAccess } from "./threadShares.js";

export function getThreadAccess(
  user: AuthUser,
  thread: ThreadMeta | undefined,
): ThreadAccess | null {
  if (!thread) return null;
  if (thread.userId === user.username) return "owner";
  if (!thread.userId) return "collaborate";
  return getSharedThreadAccess(thread.id, user.username);
}
