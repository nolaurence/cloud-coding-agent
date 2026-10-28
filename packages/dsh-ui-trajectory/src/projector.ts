import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ConversationNodeAssembler } from './conversation/assembler.ts'
import { inspectRequestPrompt } from './conversation/request-inspection.ts'
import { inspectSystemPrompt } from './conversation/system-prompt.ts'
import { trajectoryAssistantDefinition, trajectoryTurnEndDefinition } from './client/trajectory-assistant-definition.ts'
import { trajectoryCompactionDefinition, trajectorySessionEndDefinition } from './client/trajectory-compaction-definition.ts'
import { trajectoryInboxDefinition, trajectoryMessageDefinition } from './client/trajectory-message-definitions.ts'
import { trajectorySystemMessageDefinition, trajectoryRequestHeaderDefinition } from './client/trajectory-request-header-definition.ts'
import { trajectoryToolDefinition } from './client/trajectory-tool-definition.ts'
import { EMPTY_TRAJECTORY_SNAPSHOT, trajectoryViewDefinition } from './client/trajectory-snapshot-builder.ts'
import type { TrajectorySnapshot } from './client/trajectory-contract.ts'

/** Raw durable events from the authenticated native-session reader. */
export interface TrajectoryEvent {
  readonly seq: number
  readonly time: number
  readonly type: string
  readonly data: unknown
}

const definitions: readonly ConversationNodeDefinition[] = [
  trajectoryInboxDefinition,
  trajectoryMessageDefinition,
  trajectorySystemMessageDefinition(inspectSystemPrompt),
  trajectoryRequestHeaderDefinition(inspectRequestPrompt),
  trajectoryAssistantDefinition,
  trajectoryTurnEndDefinition,
  trajectoryToolDefinition,
  trajectoryCompactionDefinition,
  trajectorySessionEndDefinition,
]

/** One thread's incremental raw-event projection; no SDK or GUI runtime. */
export class TrajectoryProjector {
  private readonly assembler = new ConversationNodeAssembler(
    { entries: () => definitions, fallbackEntry: () => undefined },
    { entries: () => [trajectoryViewDefinition] },
  )
  private firstSeq: number | undefined
  private lastSeq = -1
  private hasMore = false

  constructor() {
    this.assembler.activateTarget('trajectory')
  }

  update(events: readonly TrajectoryEvent[], hasMoreBefore: boolean): TrajectorySnapshot {
    const first = events[0]?.seq
    const entries = events.map(event => ({ type: 'event' as const, event: event as SessionEvent }))
    if (first !== this.firstSeq || hasMoreBefore !== this.hasMore || (events.at(-1)?.seq ?? -1) < this.lastSeq) {
      this.assembler.replaceWindow(entries, hasMoreBefore)
    } else {
      for (const entry of entries) {
        if (entry.event.seq > this.lastSeq) this.assembler.append(entry)
      }
    }
    this.firstSeq = first
    this.lastSeq = events.at(-1)?.seq ?? -1
    this.hasMore = hasMoreBefore
    this.assembler.flush()
    return this.assembler.get('trajectory') ?? EMPTY_TRAJECTORY_SNAPSHOT
  }
}
