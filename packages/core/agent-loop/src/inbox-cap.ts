/**
 * Pure admission gate for step-boundary inbox injection: one per-item token
 * cap plus a context-window-relative cumulative cap over the pending inbox
 * projection.
 *
 * @module @deepseek-ai/dsh-agent-loop/inbox-cap
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { UserMessage } from '@deepseek-ai/dsh-session'

/** Default per-item admission cap, in estimated tokens. */
export const DEFAULT_INBOX_INJECTION_PER_ITEM_TOKENS = 2048

/** Default share of the effective context window granted to pending injected input. */
export const DEFAULT_INBOX_INJECTION_BUDGET_RATIO = 0.10

/** Resolved admission limits; {@link resolveInboxInjectionCap} fills every field. */
export interface InboxInjectionCap {
  /** Maximum estimated tokens one injected message may occupy. */
  perItem: number
  /** Share of the context window budgeted for all pending injected input together. */
  cumulativeBudgetRatio: number
}

/** Configured gate input: `'off'` disables the gate; omitted fields keep their defaults. */
export type InboxInjectionCapInput = 'off' | {
  perItem?: number
  cumulativeBudgetRatio?: number
}

/** Why one injected message was refused admission. */
export type InboxInjectionRejection =
  | { kind: 'per-item'; tokens: number; perItem: number }
  | { kind: 'cumulative'; tokens: number; budget: number; contextWindow: number }

/**
 * Fixed four-characters-per-token fold (the R4 estimate) mirroring the
 * token-meter's text density; agent-loop cannot depend on that package, so
 * the gate prices user input locally.
 */
const CHARS_PER_TOKEN = 4

/**
 * Estimate one user message's model-visible token price under the fixed
 * character fold; non-text blocks count their serialized JSON length.
 * @param message - message to price without mutation.
 * @returns estimated tokens; 0 for empty content.
 */
export function estimateInboxMessageTokens(message: UserMessage): number {
  let characters = 0
  for (const block of message.content) {
    characters += block.type === 'text' ? block.text.length : JSON.stringify(block).length
  }
  return Math.ceil(characters / CHARS_PER_TOKEN)
}

/**
 * Resolve the configured admission limits.
 * @param config - configured input, or `undefined` when the field is unset.
 * @returns the limits with every field filled, or `undefined` when disabled (`'off'`).
 */
export function resolveInboxInjectionCap(config: InboxInjectionCapInput | undefined): InboxInjectionCap | undefined {
  if (config === 'off') return undefined
  if (config === undefined) {
    return {
      perItem: DEFAULT_INBOX_INJECTION_PER_ITEM_TOKENS,
      cumulativeBudgetRatio: DEFAULT_INBOX_INJECTION_BUDGET_RATIO,
    }
  }
  return {
    perItem: config.perItem ?? DEFAULT_INBOX_INJECTION_PER_ITEM_TOKENS,
    cumulativeBudgetRatio: config.cumulativeBudgetRatio ?? DEFAULT_INBOX_INJECTION_BUDGET_RATIO,
  }
}

/**
 * Check one injected message against the admission limits. The per-item cap
 * applies to the candidate alone; the cumulative cap floors
 * `contextWindow * cumulativeBudgetRatio` and admits while the pending
 * projection plus the candidate stays at or under that budget. A missing
 * context window skips only the cumulative cap — the gate is defensive and
 * must not reject the injection path for lacking capacity data.
 * @param input.pending - queued messages both pending lists currently hold.
 * @param input.candidate - message proposed for admission.
 * @param input.cap - resolved admission limits.
 * @param input.contextWindow - session-advertised context window, when known.
 * @param input.price - token estimator applied to every message.
 * @returns the first violated limit, or `undefined` to admit.
 */
export function checkInboxInjection(input: {
  pending: readonly UserMessage[]
  candidate: UserMessage
  cap: InboxInjectionCap
  contextWindow: number | undefined
  price: (message: UserMessage) => number
}): InboxInjectionRejection | undefined {
  const tokens = input.price(input.candidate)
  if (tokens > input.cap.perItem) {
    return { kind: 'per-item', tokens, perItem: input.cap.perItem }
  }
  if (input.contextWindow === undefined) return undefined
  let total = tokens
  for (const message of input.pending) total += input.price(message)
  const budget = Math.floor(input.contextWindow * input.cap.cumulativeBudgetRatio)
  if (total > budget) {
    return { kind: 'cumulative', tokens: total, budget, contextWindow: input.contextWindow }
  }
  return undefined
}

/**
 * Render one rejection as human-readable text naming the violated limit and
 * its numbers.
 * @param rejection - rejection returned by {@link checkInboxInjection}.
 * @returns the log-facing message.
 */
export function inboxInjectionRejectionMessage(rejection: InboxInjectionRejection): string {
  switch (rejection.kind) {
    case 'per-item':
      return `injected message is ${rejection.tokens} tokens, over the per-item cap of ${rejection.perItem}; `
        + 'send it as an attachment or shorter prompt'
    case 'cumulative':
      return `pending inbox input would reach ${rejection.tokens} tokens, over the cumulative budget of `
        + `${rejection.budget} tokens (${rejection.budget}/${rejection.contextWindow} of the context window)`
    /* v8 ignore next -- the closed InboxInjectionRejection union is exhaustive */
    default:
      return assertNever(rejection)
  }
}
