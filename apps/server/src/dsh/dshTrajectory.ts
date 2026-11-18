import path from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { SessionId } from "@deepseek-ai/dsh-session";
import { SessionPersistenceNotFoundError, type SessionHandle } from "@deepseek-ai/dsh-session-persistence";
import * as JsonlPersistence from "@deepseek-ai/dsh-session-persistence-jsonl";
import type { DshTrajectoryPage, DshTrajectoryQuery } from "@cca/protocol";
import { DATA_DIR } from "../env.js";
import {
  assertTrajectoryThreadId, resolveTrajectoryQuery, trajectoryPage, unchangedTrajectoryPage,
} from "../trajectoryPaging.js";

/** Read native durable events without attaching or launching an agent runtime. */
export async function readDshTrajectory(threadId: string, query: DshTrajectoryQuery = {}): Promise<DshTrajectoryPage> {
  assertTrajectoryThreadId(threadId);
  const resolved = resolveTrajectoryQuery(query);
  const ctx = new Context();
  try {
    await ctx.plugin(JsonlPersistence, { root: path.join(DATA_DIR, "dsh-home", threadId, "sessions") });
    const id = SessionId(threadId);
    const snapshot = await ctx.sessionPersistence.stat(id);
    const revision = snapshot?.revision ?? "empty";
    if (resolved.afterSeq !== undefined && resolved.knownRevision === revision) {
      return unchangedTrajectoryPage(revision);
    }
    if (!snapshot) return trajectoryPage([], resolved, revision);
    let handle: SessionHandle;
    try {
      handle = await ctx.sessionPersistence.open(id, "read");
    } catch (error) {
      if (error instanceof SessionPersistenceNotFoundError) return trajectoryPage([], resolved, "empty");
      throw error;
    }
    try {
      return trajectoryPage((await handle.read()).events, resolved, revision);
    } finally {
      await handle.close();
    }
  } finally {
    await ctx.fiber.dispose();
  }
}
