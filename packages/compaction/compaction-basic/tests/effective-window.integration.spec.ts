/**
 * W1′ acceptance · integration (A1 over-budget sessions compress before sending, A3 the
 * routed target drives the budget, A4 normal-volume sessions gain no extra compaction).
 *
 * The mock relay both *declares* the legacy virtual window and *enforces* a physical cap, so the
 * two layers stay distinguishable: capacity now comes from the resolution chain (`glm` → the
 * conservative 262,144 default, DeepSeek → 1,000,000) while the cap only decides whether the
 * emitted request would have been rejected with a gateway 400 (classified through the same
 * public matcher production uses, `llm-deepseek/src/adapter.ts:340`).
 *
 * Fixture volume is ~370,054 tokens: above the conservative threshold (209,715) and below both
 * the DeepSeek threshold (800,000) and the previously-effective virtual threshold — so the case
 * discriminates capacity sources rather than restating them.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  LlmAdapter,
  LlmError,
  createMessage,
  createUserMessage,
  resolveRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  Message,
  ResolvedRetryPolicy,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

/** Providers registered on the mock relay (one per capacity tier under test). */
const RELAY_GLM = 'relay-glm'
const DEEPSEEK = 'deepseek-official'
const RELAY_HUOSHAN = 'modlens-huoshan-engine'
const GLM_MODEL = 'glm-5.3'
const DEEPSEEK_MODEL = 'deepseek/deepseek-v4.1-flash'

/** Gateway 400 original text (13bbf5c9 / huoshan turn 179). */
const GATEWAY_400_LONGER =
  '400: {"message":"{\\"message\\":\\"The input is longer than the model\'s context length trace_id: bead14916ec206f5451241a41bc3c894\\",\\"type\\":\\"invalid_request_error\\"}\\n","type":"invalid_request_error"}'

/** Classify a relay failure exactly as production does (400 branch of `httpErrorCode`). */
function classifiedCode(): string {
  return isContextWindowExceededError(GATEWAY_400_LONGER)
    ? CONTEXT_WINDOW_EXCEEDED_CODE
    : 'INVALID_REQUEST'
}

/** Mock relay with a physical request cap; summarization calls are exempt as in the harness. */
class CappedRelayAdapter extends LlmAdapter {
  readonly conversationRequests: GenerateOptions[] = []
  readonly summaryRequests: GenerateOptions[] = []
  readonly pricedRequests: number[] = []
  private readonly retryPolicy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 1,
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'w1-prime integration retryPolicy')

  constructor(
    private readonly priceMessages: (messages: readonly Message[]) => number,
    private readonly physicalCapTokens: number,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      // Still the legacy virtual window: W1′ no longer reads it for capacity.
      context: { contextWindow: 1_000_000 },
    })
  }

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const trailing = options.messages.at(-1)?.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('') ?? ''
    if (trailing.includes('acting as a compaction engine')) {
      this.summaryRequests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'RECOVERY CHECKPOINT' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    this.conversationRequests.push(options)
    const priced = this.priceMessages(options.messages)
    this.pricedRequests.push(priced)
    if (priced > this.physicalCapTokens) {
      throw new LlmError(GATEWAY_400_LONGER, classifiedCode())
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

/**
 * Replayed history whose metered volume lands in the discriminating band.
 *
 * Shape follows the proven fixture: a routed header inside an open step, closed turns for volume,
 * and one trailing open turn for the durable compaction events of the follow-up request. The route
 * matters — `compactIfNeeded` deliberately declines pressure work without one.
 */
function historySeed(repeat: number, provider: string, model: string): SessionEvent[] {
  const session = Session.create(SessionId('w1-prime-seed'))
  for (let turn = 1; turn <= 2; turn += 1) {
    const sentinel = turn === 1 ? 'OLD HISTORY SENTINEL' : 'RECENT HISTORY'
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${sentinel} ${'stale context payload '.repeat(repeat)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider, model } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `historical response ${turn} ${'detail payload '.repeat(repeat)}` }],
        source: { kind: 'model', ...{ provider, model } },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return [...session.events]
}

interface ScenarioResult {
  volume: number
  firstRequest: number | undefined
  conversationRequests: number
  summaryRequests: number
  compactions: readonly string[]
  lastEvent: SessionEvent | undefined
}

async function runScenario(options: {
  sessionId: string
  provider: string
  model: string
  physicalCap: number
  repeat: number
  config?: BasicCompactionConfig
}): Promise<ScenarioResult> {
  const ctx = new Context()
  const adapter = new CappedRelayAdapter(
    messages => messages.reduce((total, message) => total + ctx.tokenMeter.estimateMessage(message), 0),
    options.physicalCap,
  )
  await mountAgentLoopTestDependencies(ctx)
  await mountInvariants(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  ctx.llm.registerAdapter([RELAY_GLM, DEEPSEEK, RELAY_HUOSHAN], adapter)
  await ctx.plugin(BasicCompactionEngine, options.config ?? {})

  const { agent } = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId(options.sessionId),
    seed: historySeed(options.repeat, options.provider, options.model),
    agentOptions: { provider: options.provider, model: options.model },
  })
  const volume = ctx.tokenMeter.measure(agent.session).totalTokens
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'continue from history' }],
    source: { kind: 'user' },
  }))
  await agent.whenIdle()

  const events = [...agent.session.events]
  return {
    volume,
    firstRequest: adapter.pricedRequests[0],
    conversationRequests: adapter.conversationRequests.length,
    summaryRequests: adapter.summaryRequests.length,
    compactions: events
      .filter(event => event.type === 'compaction/start'
        || event.type === 'compaction/summary'
        || event.type === 'compaction/end')
      .map(event => event.type),
    lastEvent: events.at(-1),
  }
}

describe('W1′ 集成验收', () => {
  it('A1：超预算会话在发请求前压缩，未能装下真实上限的 400 不再发生', async () => {
    const result = await runScenario({
      sessionId: 'w1-a1-glm',
      provider: RELAY_GLM,
      model: GLM_MODEL,
      // Below the fixture volume: without pre-send compression this request would 400.
      physicalCap: 300_000,
      repeat: 20_000,
    })
    console.log(
      `[A1] 会话体量=${result.volume} | 首请求=${result.firstRequest}（<真实上限 300000 ⇒ 不再 400） | `
      + `请求数=${result.conversationRequests} | 压缩=${result.compactions.length}`,
    )

    expect(result.volume).toBeGreaterThan(209_715) // 超过保守窗阈值 ⇒ 压力路径必触发
    expect(result.compactions).toEqual([
      'compaction/start',
      'compaction/summary',
      'compaction/end',
    ])
    expect(result.conversationRequests).toBe(1)
    expect(result.summaryRequests).toBe(1)
    expect(result.firstRequest).toBeLessThan(300_000)
    expect(result.lastEvent).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
  })

  it('A3：同一会话体量下，压缩与否由路由目标的有效窗决定', async () => {
    const capped = 500_000 // 高于未压缩请求体量 ⇒ 隔离「是否压缩」这一决策
    const glm = await runScenario({
      sessionId: 'w1-a3-glm',
      provider: RELAY_GLM,
      model: GLM_MODEL,
      physicalCap: capped,
      repeat: 20_000,
    })
    const deepseek = await runScenario({
      sessionId: 'w1-a3-deepseek',
      provider: DEEPSEEK,
      model: DEEPSEEK_MODEL,
      physicalCap: capped,
      repeat: 20_000,
    })
    console.log(
      `[A3] glm 目标：体量=${glm.volume} 压缩=${glm.compactions.length} 请求=${glm.conversationRequests}`
      + ` | deepseek 目标：体量=${deepseek.volume} 压缩=${deepseek.compactions.length} 请求=${deepseek.conversationRequests}`,
    )

    expect(glm.volume).toBe(deepseek.volume) // 同一体量，唯一变量 = 路由目标
    expect(glm.compactions).toHaveLength(3) // 262,144 档 ⇒ 阈值 209,715 ⇒ 触发
    expect(deepseek.compactions).toHaveLength(0) // 1,000,000 档 ⇒ 阈值 800,000 ⇒ 不触发
    expect(glm.conversationRequests).toBe(1)
    expect(deepseek.conversationRequests).toBe(1)
    expect(deepseek.lastEvent).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })
  })

  it('A3②：前缀形态归一化后同样落到 DeepSeek 真窗（deepseek/deepseek-v4.1-flash）', async () => {
    const result = await runScenario({
      sessionId: 'w1-a3-prefix',
      provider: RELAY_HUOSHAN,
      model: 'deepseek/deepseek-v4.1-flash',
      physicalCap: 500_000,
      repeat: 20_000,
    })
    // 归一化到 deepseek-flash ⇒ 阈值 800,000 > 体量 ⇒ 不发无谓压缩。
    expect(result.compactions).toHaveLength(0)
    expect(result.conversationRequests).toBe(1)
  })

  it('A4：正常体量会话在两个容量档下都不产生额外压缩', async () => {
    const glm = await runScenario({
      sessionId: 'w1-a4-glm',
      provider: RELAY_GLM,
      model: GLM_MODEL,
      physicalCap: 500_000,
      repeat: 2,
    })
    const deepseek = await runScenario({
      sessionId: 'w1-a4-deepseek',
      provider: DEEPSEEK,
      model: DEEPSEEK_MODEL,
      physicalCap: 500_000,
      repeat: 2,
    })
    console.log(`[A4] 正常体量：glm=${glm.volume} tokens / deepseek=${deepseek.volume} tokens，压缩次数均为 0`)

    for (const result of [glm, deepseek]) {
      expect(result.volume).toBeLessThan(209_715)
      expect(result.compactions).toHaveLength(0)
      expect(result.conversationRequests).toBe(1)
      expect(result.lastEvent).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'completed' } },
      })
    }
  })

  it('⑤：legacy-1e6 开关把 glm 目标恢复成虚高阈值（一键回退）', async () => {
    const result = await runScenario({
      sessionId: 'w1-legacy',
      provider: RELAY_GLM,
      model: GLM_MODEL,
      physicalCap: 500_000,
      repeat: 20_000,
      config: { contextWindowSource: 'legacy-1e6' },
    })
    // 阈值 = min(800,000, 952,000) = 800,000 > 体量 ⇒ 与本修复前的虚高行为一致。
    expect(result.compactions).toHaveLength(0)
    expect(result.conversationRequests).toBe(1)
  })
})
