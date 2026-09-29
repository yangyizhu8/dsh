/**
 * Inbox injection cap decisions (W3).
 *
 * Pure helpers so the gate's arithmetic is unit-testable without a live loop. The cumulative
 * term is always derived from the caller's current pending lists — never from a separate
 * counter — so leaving the queue (claim/remove/clear) automatically frees budget and a replayed
 * session recomputes the same value from its durable splices.
 *
 * @module @deepseek-ai/dsh-agent-loop/inbox-cap
 */
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** Default per-message injection cap (tokens). */
export const DEFAULT_INBOX_INJECTION_PER_ITEM_TOKENS = 2_048

/** Default cumulative share of the effective context window available to pending injections. */
export const DEFAULT_INBOX_INJECTION_BUDGET_RATIO = 0.10

/** Configured cap value as accepted from the plugin config. */
export type InboxInjectionCapConfig =
  | 'off'
  | {
    perItem?: number
    cumulativeBudgetRatio?: number
  }

/** Validated cap values, or `'off'` for the one-line rollback. */
export type ResolvedInboxInjectionCap = {
  perItem: number
  cumulativeBudgetRatio: number
} | 'off'

/** Why one injection was refused before entering a pending list. */
export type InboxInjectionRejection =
  | { kind: 'per-item'; tokens: number; limit: number }
  | { kind: 'cumulative'; tokens: number; budget: number; contextWindow: number }

/**
 * Resolve the configured cap, applying documented defaults.
 * @param config - raw plugin configuration value, when present.
 * @returns validated cap values, or `'off'`.
 */
export function resolveInboxInjectionCap(
  config: InboxInjectionCapConfig | undefined,
): ResolvedInboxInjectionCap {
  if (config === 'off') return 'off'
  const perItem = config?.perItem ?? DEFAULT_INBOX_INJECTION_PER_ITEM_TOKENS
  const cumulativeBudgetRatio = config?.cumulativeBudgetRatio ?? DEFAULT_INBOX_INJECTION_BUDGET_RATIO
  if (perItem === 'off' as never) return 'off'
  return { perItem, cumulativeBudgetRatio }
}

/** Human-readable rejection detail, shared by the log line and tests. */
export function inboxInjectionRejectionMessage(rejection: InboxInjectionRejection): string {
  return rejection.kind === 'per-item'
    ? `inbox injection refused: message is ${rejection.tokens} tokens, above the per-item cap `
      + `of ${rejection.limit}; send it as an attachment or shorter prompt`
    : `inbox injection refused: pending injections would reach ${rejection.tokens} tokens, above the `
      + `budget of ${rejection.budget} (${rejection.contextWindow}-token window × ratio)`
}

/**
 * Decide whether one message may join the pending inbox lists.
 * @param args - pending messages, candidate, resolved cap, window and pricing function.
 * @returns the rejection reason, or `undefined` when the candidate may be queued.
 */
export function checkInboxInjection(args: {
  readonly pending: readonly UserMessage[]
  readonly candidate: UserMessage
  readonly cap: Exclude<ResolvedInboxInjectionCap, 'off'>
  readonly contextWindow: number
  readonly price: (message: UserMessage) => number
}): InboxInjectionRejection | undefined {
  const tokens = args.price(args.candidate)
  if (tokens > args.cap.perItem) {
    return { kind: 'per-item', tokens, limit: args.cap.perItem }
  }
  const pendingTokens = args.pending.reduce((total, message) => total + args.price(message), 0)
  const budget = Math.floor(args.contextWindow * args.cap.cumulativeBudgetRatio)
  const projected = pendingTokens + tokens
  return projected > budget
    ? { kind: 'cumulative', tokens: projected, budget, contextWindow: args.contextWindow }
    : undefined
}
