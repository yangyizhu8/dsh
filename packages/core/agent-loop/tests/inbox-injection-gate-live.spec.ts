/**
 * W3 live wiring · the injection gate must actually refuse at `inject()`, not merely compute.
 *
 * The pure-function cases pin the arithmetic; these cases pin the *wiring*, so a future change
 * that computes a rejection and then ignores it (the "validator passes but the gate does not"
 * trap) turns this file red.
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/** Test-local stand-in for the compaction backend's capability: one huge message, small rest. */
class StubInboxCapacity extends Service {
  constructor(ctx: Context) {
    super(ctx, 'inboxCapacity')
  }

  resolveContextWindow(): { contextWindow: number; source: 'conservative-default' } {
    return { contextWindow: 262_144, source: 'conservative-default' }
  }

  priceMessage(message: UserMessage): number {
    const text = message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
    return text.includes('HUGE') ? 3_000 : 10
  }
}

async function harness(options: {
  readonly withCapacity: boolean
  readonly cap?: 'off' | { perItem?: number; cumulativeBudgetRatio?: number }
}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (options.withCapacity) await ctx.plugin(StubInboxCapacity)
  await ctx.plugin(AgentLoop, {
    agents: [],
    ...options.cap === undefined ? {} : { inboxInjectionCap: options.cap },
  })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('ok')]))
  return ctx
}

function pluginMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'p' } })
}

describe('W3 · 注入闸活体接线', () => {
  it('① 单条超限：inject() 不抛错、消息未入队、拒收原因可见', async () => {
    const ctx = await harness({ withCapacity: true, cap: { perItem: 2_048, cumulativeBudgetRatio: 0.1 } })
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    const agent = ctx.agentLoop.create(SessionId('w3-live-per-item'), { provider: 'mock', model: 'mock' })

    expect(() => agent.inject(pluginMessage('HUGE payload'))).not.toThrow()

    // Not enqueued anywhere: neither pending list nor the durable log gained it.
    expect(agent.inbox.nextStep).toHaveLength(0)
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(agent.session.events.filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(0)
    expect(warnings.some(line => line.includes('inbox injection refused'))).toBe(true)
    expect(warnings.some(line => line.includes('3000 tokens'))).toBe(true)

    // The gate must not disturb the normal path either.
    agent.inject(pluginMessage('small context'))
    expect(agent.inbox.nextStep).toHaveLength(1)
    expect(agent.session.events.filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(1)
  })

  it('② 服务缺席：闸门不生效（消息正常入队）+ inactive warn 恰一次', async () => {
    const ctx = await harness({ withCapacity: false })
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    const agent = ctx.agentLoop.create(SessionId('w3-live-absent'), { provider: 'mock', model: 'mock' })

    agent.inject(pluginMessage('HUGE payload'))
    agent.inject(pluginMessage('another payload'))

    expect(agent.inbox.nextStep).toHaveLength(2)
    expect(
      warnings.filter(line => line.includes('inbox injection cap inactive: no capacity service')),
    ).toHaveLength(1)
    expect(warnings.some(line => line.includes('inbox injection refused'))).toBe(false)
  })

  it('②-b \'off\' 一键回退：超限消息照常入队、无任何闸门告警', async () => {
    const ctx = await harness({ withCapacity: true, cap: 'off' })
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    const agent = ctx.agentLoop.create(SessionId('w3-live-off'), { provider: 'mock', model: 'mock' })

    agent.inject(pluginMessage('HUGE payload'))

    expect(agent.inbox.nextStep).toHaveLength(1)
    expect(warnings.filter(line => line.includes('inbox injection'))).toHaveLength(0)
  })
})
