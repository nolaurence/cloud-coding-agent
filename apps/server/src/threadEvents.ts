import type { SessionEvent } from "@github/copilot-sdk";
import { enqueueWrite, flushDbWrites, query, transaction, upsert, usingDatabase } from "./db.js";

// JSONL remains a write-ahead journal. Replaying stable IDs repairs interrupted DB writes.
export class ThreadEventStore {
  private pending: { event: SessionEvent; sequence: number }[] = [];
  private queued = false;
  private failure: unknown;
  constructor(private readonly threadId: string, private readonly onError: (error: unknown) => void) {}

  append(event: SessionEvent, sequence: number) {
    if (!usingDatabase() || this.failure) return;
    this.pending.push({ event, sequence });
    if (this.queued || this.failure) return;
    this.queued = true;
    enqueueWrite(async () => {
      try {
        while (this.pending.length) {
          const batch = this.pending.slice(0, 100);
          await transaction(async (execute) => {
            for (const { event, sequence } of batch) await upsert({
              table: "thread_events",
              values: { thread_id: this.threadId, event_id: event.id, sequence_number: sequence,
                event_type: event.type, occurred_at: event.timestamp, data: JSON.stringify(event) },
              conflictColumns: ["thread_id", "event_id"], updateColumns: [],
            }, execute);
          });
          this.pending.splice(0, batch.length);
        }
      } catch (error) {
        this.failure = error;
        this.onError(error);
        throw error;
      } finally { this.queued = false; }
    });
  }

  assertHealthy() {
    if (this.failure) throw this.failure;
  }

  async flush() {
    await flushDbWrites();
    this.assertHealthy();
  }

  async read(): Promise<SessionEvent[]> {
    await this.flush();
    const { rows } = await query<{ data: string | SessionEvent }>(
      "SELECT data FROM thread_events WHERE thread_id = ? ORDER BY sequence_number", [this.threadId]);
    return rows.map(({ data }) => typeof data === "string" ? JSON.parse(data) as SessionEvent : data);
  }
}

export async function deleteThreadEvents(threadId: string) {
  if (!usingDatabase()) return;
  await flushDbWrites();
  await query("DELETE FROM thread_events WHERE thread_id = ?", [threadId]);
}

export async function copyThreadEvents(sourceId: string, destId: string) {
  if (!usingDatabase()) return;
  if (sourceId === destId) throw new Error("不能分叉到同一会话");
  await flushDbWrites();
  const { rows } = await query<{
    event_id: string;
    sequence_number: number | bigint | string;
    event_type: string;
    occurred_at: string;
    data: string | SessionEvent;
  }>(
    "SELECT event_id, sequence_number, event_type, occurred_at, data FROM thread_events WHERE thread_id = ? ORDER BY sequence_number",
    [sourceId],
  );
  if (rows.length === 0) return;
  await transaction(async (execute) => {
    for (const row of rows) {
      await upsert(
        {
          table: "thread_events",
          values: {
            thread_id: destId,
            event_id: row.event_id,
            sequence_number: Number(row.sequence_number),
            event_type: row.event_type,
            occurred_at: row.occurred_at,
            data: typeof row.data === "string" ? row.data : JSON.stringify(row.data),
          },
          conflictColumns: ["thread_id", "event_id"],
          updateColumns: [],
        },
        execute,
      );
    }
  });
}
