/**
 * Durable agent session-event vocabulary shared with type-only consumers.
 *
 * @module @deepseek-ai/dsh-agent/types
 */

import type { UserMessage } from '@deepseek-ai/dsh-llm/types'

/** One of the two ordered pending-message lists owned by an agent. */
export type InboxTarget = 'next-turn' | 'next-step'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One normalized mutation of an agent's durable pending-message lists.
     * Live dispatch precedes projection mutation, so synchronous observers may
     * read the pre-splice inbox to recover the removed messages.
     */
    'agent/inbox/spliced': {
      target: InboxTarget
      start: number
      removedCount?: number
      inserted: UserMessage[]
      outcome?: 'canceled'
    }
  }
}

/** Provenance of one resolved capacity window, mirroring the compaction capacity chain. */
export type InboxCapacitySource =
  | 'legacy'
  | 'override'
  | 'model-table'
  | 'conservative-default'
  | 'transfer-cap'

/**
 * Optional capability a compaction backend publishes so the agent loop can bound
 * programmatic inbox injections by the same capacity chain that drives compaction
 * pressure (W3). Both ends already depend on `@deepseek-ai/dsh-agent`, so this shared
 * contract adds no dependency edge.
 *
 * Absence is an operational state, not an error: a composition without such a backend
 * leaves the injection cap inactive and warns once — never silently.
 */
export interface InboxCapacityResolver {
  /**
   * Resolve the effective context window for one routed target, immediately.
   * Called per injection so a mid-session model switch is honored.
   * @param provider - routed provider of the session's current target.
   * @param model - routed model id of the session's current target.
   * @returns the effective window in tokens plus its provenance.
   */
  resolveContextWindow(provider: string, model: string): {
    contextWindow: number
    source: InboxCapacitySource
  }
  /**
   * Price one model-visible message under the same heuristic the compaction path uses.
   * @param message - message about to enter a pending inbox list.
   * @returns estimated tokens for that message.
   */
  priceMessage(message: UserMessage): number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Present when a compaction backend that bounds inbox injections is mounted. */
    inboxCapacity?: InboxCapacityResolver
  }
}
