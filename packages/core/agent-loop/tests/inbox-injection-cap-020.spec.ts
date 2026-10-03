/** W3 inbox injection cap: pure gate semantics and the inject() admission hook (UPG-020 WO-05). */

import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  DEFAULT_INBOX_INJECTION_BUDGET_RATIO,
  DEFAULT_INBOX_INJECTION_PER_ITEM_TOKENS,
  checkInboxInjection,
  estimateInboxMessageTokens,
  inboxInjectionRejectionMessage,
  resolveInboxInjectionCap,
} from '../src/inbox-cap.ts'

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Price every message at a fixed token count for exact cumulative boundaries. */
const fixedPrice = (tokens: number) => (): number => tokens

describe('resolveInboxInjectionCap', () => {
  it('resolves the documented defaults when config is omitted or partial', () => {
    expect(resolveInboxInjectionCap(undefined)).toEqual({
      perItem: DEFAULT_INBOX_INJECTION_PER_ITEM_TOKENS,
      cumulativeBudgetRatio: DEFAULT_INBOX_INJECTION_BUDGET_RATIO,
    })
    expect(DEFAULT_INBOX_INJECTION_PER_ITEM_TOKENS).toBe(2048)
    expect(DEFAULT_INBOX_INJECTION_BUDGET_RATIO).toBe(0.10)
    expect(resolveInboxInjectionCap({})).toEqual({
      perItem: 2048,
      cumulativeBudgetRatio: 0.10,
    })
    expect(resolveInboxInjectionCap({ perItem: 512 })).toEqual({
      perItem: 512,
      cumulativeBudgetRatio: 0.10,
    })
    expect(resolveInboxInjectionCap({ cumulativeBudgetRatio: 0.25 })).toEqual({
      perItem: 2048,
      cumulativeBudgetRatio: 0.25,
    })
  })

  it("returns undefined for 'off', disabling the gate", () => {
    expect(resolveInboxInjectionCap('off')).toBeUndefined()
  })
})

describe('checkInboxInjection', () => {
  it('rejects one candidate over the per-item cap and names the recovery in the message', () => {
    const rejection = checkInboxInjection({
      pending: [],
      candidate: userMessage('x'.repeat(8193)),
      cap: { perItem: 2048, cumulativeBudgetRatio: 0.10 },
      contextWindow: 131072,
      price: estimateInboxMessageTokens,
    })
    expect(rejection).toEqual({ kind: 'per-item', tokens: 2049, perItem: 2048 })
    expect(inboxInjectionRejectionMessage(rejection!)).toContain('send it as an attachment or shorter prompt')
  })

  it('rejects pending-plus-candidate over the floored window budget and records the window', () => {
    const pending = Array.from({ length: 7 }, (_, index) => userMessage(`pending ${index}`))
    const rejection = checkInboxInjection({
      pending,
      candidate: userMessage('candidate'),
      cap: { perItem: 2048, cumulativeBudgetRatio: 0.10 },
      contextWindow: 131072,
      price: fixedPrice(2000),
    })
    expect(rejection).toEqual({ kind: 'cumulative', tokens: 16000, budget: 13107, contextWindow: 131072 })
    const message = inboxInjectionRejectionMessage(rejection!)
    expect(message).toContain('131072')
    expect(message).toContain('13107')
  })

  it('admits input at or under both caps, including the exact budget boundary', () => {
    expect(checkInboxInjection({
      pending: [],
      candidate: userMessage('x'.repeat(8192)),
      cap: { perItem: 2048, cumulativeBudgetRatio: 0.10 },
      contextWindow: 131072,
      price: estimateInboxMessageTokens,
    })).toBeUndefined()
    const cap = { perItem: 20000, cumulativeBudgetRatio: 0.10 }
    expect(checkInboxInjection({
      pending: [],
      candidate: userMessage('exactly at budget'),
      cap,
      contextWindow: 131072,
      price: fixedPrice(13107),
    })).toBeUndefined()
    expect(checkInboxInjection({
      pending: [],
      candidate: userMessage('one over budget'),
      cap,
      contextWindow: 131072,
      price: fixedPrice(13108),
    })).toMatchObject({ kind: 'cumulative' })
  })

  it('derives the cumulative total from the pending projection, so leaving the queue releases budget', () => {
    const candidate = userMessage('candidate')
    const cap = { perItem: 2048, cumulativeBudgetRatio: 0.10 }
    const stillQueued = Array.from({ length: 7 }, (_, index) => userMessage(`pending ${index}`))
    expect(checkInboxInjection({
      pending: stillQueued,
      candidate,
      cap,
      contextWindow: 131072,
      price: fixedPrice(2000),
    })).toMatchObject({ kind: 'cumulative' })
    expect(checkInboxInjection({
      pending: [],
      candidate,
      cap,
      contextWindow: 131072,
      price: fixedPrice(2000),
    })).toBeUndefined()
  })

  it('keeps only the per-item cap when no context window is available yet', () => {
    const cap = { perItem: 2048, cumulativeBudgetRatio: 0.10 }
    expect(checkInboxInjection({
      pending: Array.from({ length: 7 }, (_, index) => userMessage(`pending ${index}`)),
      candidate: userMessage('candidate'),
      cap,
      contextWindow: undefined,
      price: fixedPrice(2000),
    })).toBeUndefined()
    expect(checkInboxInjection({
      pending: [],
      candidate: userMessage('x'.repeat(8193)),
      cap,
      contextWindow: undefined,
      price: estimateInboxMessageTokens,
    })).toMatchObject({ kind: 'per-item' })
  })
})

describe('estimateInboxMessageTokens', () => {
  it('prices text content at four characters per token and counts non-text blocks positively', () => {
    expect(estimateInboxMessageTokens(userMessage(''))).toBe(0)
    expect(estimateInboxMessageTokens(userMessage('abcd'))).toBe(1)
    expect(estimateInboxMessageTokens(userMessage('abcde'))).toBe(2)
    const reasoning = { type: 'reasoning', text: 'efgh' } as const
    const withNonText = createUserMessage({
      content: [{ type: 'text', text: 'abcd' }, reasoning],
      source: { kind: 'user' },
    })
    expect(estimateInboxMessageTokens(withNonText))
      .toBe(1 + Math.ceil(JSON.stringify(reasoning).length / 4))
  })
})

describe('ReactLoopAgent.inject admission hook', () => {
  async function harness(): Promise<Context> {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    return ctx
  }

  it('discards an oversized injected message without queueing it, then admits smaller input', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('cap-live-reject'), { provider: 'mock', model: 'mock' })
    agent.session.append('request/context', { provider: 'mock', model: 'mock', contextWindow: 131072 })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const discarded: UserMessage[] = []
    ctx.on('agent/inbox/discarded', ({ message }) => void discarded.push(message))
    const oversized = userMessage('x'.repeat(8193))
    const admitted = userMessage('small')

    expect(() => agent.inject(oversized)).not.toThrow()
    expect(discarded).toEqual([oversized])
    expect(agent.inbox.nextStep).toEqual([])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced')).toEqual([])

    agent.inject(admitted)
    expect(agent.inbox.nextStep).toEqual([admitted])
    expect(discarded).toEqual([oversized])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]![0])).toContain('send it as an attachment or shorter prompt')
  })

  it('warns exactly once about the missing capacity source while keeping the per-item cap', async () => {
    const ctx = await harness()
    const agent = await ctx.agentLoop.create(SessionId('cap-live-no-window'), { provider: 'mock', model: 'mock' })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const first = userMessage('first')
    const second = userMessage('second')
    const oversized = userMessage('x'.repeat(8193))

    agent.inject(first)
    agent.inject(second)
    expect(agent.inbox.nextStep).toEqual([first, second])

    agent.inject(oversized)
    expect(agent.inbox.nextStep).toEqual([first, second])
    const sourceWarnings = warn.mock.calls.filter(([message]) => String(message).includes('context window'))
    expect(sourceWarnings).toHaveLength(1)
  })

  it('parses the inboxInjectionCap config field through the plugin schema', () => {
    expect(AgentLoop.Config({ agents: [] }).inboxInjectionCap.get()).toBeUndefined()
    expect(AgentLoop.Config({ agents: [], inboxInjectionCap: 'off' }).inboxInjectionCap.get()).toBe('off')
    expect(AgentLoop.Config({ agents: [], inboxInjectionCap: { perItem: 512 } }).inboxInjectionCap.get())
      .toEqual({ perItem: 512 })
  })
})
