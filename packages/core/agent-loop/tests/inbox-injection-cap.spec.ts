/**
 * W3 acceptance · inbox injection cap (single-item, cumulative, zero-impact, absence, rollback).
 *
 * The cumulative term is asserted through the live pending lists rather than a counter, so these
 * cases also pin the documented "derived from projection" contract: leaving the queue frees budget.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_INBOX_INJECTION_BUDGET_RATIO,
  DEFAULT_INBOX_INJECTION_PER_ITEM_TOKENS,
  checkInboxInjection,
  inboxInjectionRejectionMessage,
  resolveInboxInjectionCap,
} from '../src/inbox-cap.ts'
import type { UserMessage } from '@deepseek-ai/dsh-llm'

/** Message stand-in priced through the injected pricing function below. */
function message(id: string): UserMessage {
  return { id, content: [{ type: 'text', text: id }] } as unknown as UserMessage
}

const price = (value: UserMessage): number => Number((value as unknown as { id: string }).id)

describe('W3 · 注入闸口径', () => {
  it('resolves documented defaults and the explicit rollback', () => {
    expect(resolveInboxInjectionCap(undefined)).toEqual({
      perItem: DEFAULT_INBOX_INJECTION_PER_ITEM_TOKENS,
      cumulativeBudgetRatio: DEFAULT_INBOX_INJECTION_BUDGET_RATIO,
    })
    expect(resolveInboxInjectionCap('off')).toBe('off')
    expect(resolveInboxInjectionCap({ perItem: 512, cumulativeBudgetRatio: 0.05 })).toEqual({
      perItem: 512,
      cumulativeBudgetRatio: 0.05,
    })
  })

  it('① 单条超限：拒收并给出可读提示（含实测 tokens 与上限）', () => {
    const rejection = checkInboxInjection({
      pending: [],
      candidate: message('3000'),
      cap: { perItem: 2_048, cumulativeBudgetRatio: 0.1 },
      contextWindow: 262_144,
      price,
    })
    expect(rejection).toEqual({ kind: 'per-item', tokens: 3_000, limit: 2_048 })
    const text = inboxInjectionRejectionMessage(rejection!)
    expect(text).toContain('3000 tokens')
    expect(text).toContain('2048')
    expect(text).toContain('attachment')
  })

  it('② 累计超限：按在队求和 + 新条判定（含预算与窗口留痕）', () => {
    const rejection = checkInboxInjection({
      pending: [message('1500'), message('300')],
      candidate: message('400'),
      cap: { perItem: 2_048, cumulativeBudgetRatio: 0.1 },
      contextWindow: 2_000, // 预算 = 200
      price,
    })
    expect(rejection).toEqual({ kind: 'cumulative', tokens: 2_200, budget: 200, contextWindow: 2_000 })
    expect(inboxInjectionRejectionMessage(rejection!)).toContain('budget of 200')
  })

  it('③ 上限内零影响：单条与累计均在上限内 ⇒ 无判定（等价旧行为）', () => {
    expect(checkInboxInjection({
      pending: [message('100')],
      candidate: message('200'),
      cap: { perItem: 2_048, cumulativeBudgetRatio: 0.1 },
      contextWindow: 262_144, // 预算 26,214
      price,
    })).toBeUndefined()
    // 恰好等于上限 ⇒ 不拒（边界取「大于」才拒）
    expect(checkInboxInjection({
      pending: [],
      candidate: message('2048'),
      cap: { perItem: 2_048, cumulativeBudgetRatio: 0.1 },
      contextWindow: 20_480, // 预算 2,048
      price,
    })).toBeUndefined()
  })

  it('④ 离队即释放预算（派生自投影，无独立计数器）', () => {
    const cap = { perItem: 2_048, cumulativeBudgetRatio: 0.1 }
    const contextWindow = 10_000 // 预算 1,000
    expect(checkInboxInjection({
      pending: [message('900')],
      candidate: message('200'),
      cap,
      contextWindow,
      price,
    })).toMatchObject({ kind: 'cumulative' })
    // Same candidate after the queued one was claimed ⇒ accepted, because the sum is derived.
    expect(checkInboxInjection({
      pending: [],
      candidate: message('200'),
      cap,
      contextWindow,
      price,
    })).toBeUndefined()
  })

  it('⑤ legacy-1e6 交互一致性：同一在队体量下，闸门基数随容量链放宽', () => {
    const cap = { perItem: 2_048, cumulativeBudgetRatio: 0.1 }
    const pending = [message('26000')]
    const candidate = message('2000')
    // effective 档（未知模型 262,144）⇒ 预算 floor(262144 × 0.1) = 26,214 ⇒ 26,000 + 2,000 超限
    expect(checkInboxInjection({
      pending, candidate, cap, contextWindow: 262_144, price,
    })).toMatchObject({ kind: 'cumulative', budget: 26_214, contextWindow: 262_144 })
    // legacy-1e6 ⇒ 预算 100,000 ⇒ 同一体量通过（回退把闸门基数一并放宽，属预期一致性）
    expect(checkInboxInjection({
      pending, candidate, cap, contextWindow: 1_000_000, price,
    })).toBeUndefined()
    expect(Math.floor(1_000_000 * cap.cumulativeBudgetRatio)).toBe(100_000)
  })
})
