import fs from "node:fs";
import path from "node:path";
import type { ContextBreakdown } from "@cca/protocol";
import { DATA_DIR } from "../env.js";

const SESSION_ID = /^[A-Za-z0-9-]{1,100}$/;

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** Read the DSH token-meter composition from its durable projection cache. */
export function readDshContextBreakdown(
  threadId: string,
  root = path.join(DATA_DIR, "dsh-home"),
): ContextBreakdown | undefined {
  if (!SESSION_ID.test(threadId)) return undefined;
  const file = path.join(
    root,
    threadId,
    "storages",
    "session_projcache",
    "sessions",
    `${threadId}.json`,
  );
  try {
    const document = JSON.parse(fs.readFileSync(file, "utf8")) as {
      record?: { rows?: { contextBreakdown?: { val?: { breakdown?: Record<string, unknown> } } } };
    };
    const breakdown = document.record?.rows?.contextBreakdown?.val?.breakdown;
    if (!breakdown) return undefined;
    const systemTokens = tokenCount(breakdown.systemTokens);
    const toolsTokens = tokenCount(breakdown.toolsTokens);
    const messageTokens = tokenCount(breakdown.messageTokens);
    if (systemTokens === undefined || toolsTokens === undefined || messageTokens === undefined) {
      return undefined;
    }
    return { systemTokens, toolsTokens, messageTokens };
  } catch {
    return undefined;
  }
}
