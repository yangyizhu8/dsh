/**
 * A2④ · W2′-only 集成级：容量层仍为 legacy-1e6 时的 overflow 救援可容性（W2′ 验收用例）。
 *
 * 等价构造声明（供复核）——
 *   mock adapter 的 resolveModel 报 contextWindow = 1_000_000，而 resolveCompactSpec 取
 *   `thresholdTokens = Math.floor(contextWindow × thresholdRatio)`（config.ts:144）；
 *   本用例取 thresholdRatio: 1 ⇒ thresholdTokens = 1_000_000
 *   ⇒ 对任何体量 < 1e6 的会话，**压力路径恒不触发**——与 `contextWindowSource: 'legacy-1e6'`
 *   （阈值 80 万 / 1e6 级虚高）语义等价 ⇒ 本用例即 A2④ 要求的「W2′-only 最不利组合」。
 *
 * 模拟层的真实性（本用例的核心，不可替换为硬编码错误码）——
 *   400 的 `CONTEXT_WINDOW_EXCEEDED` 码**不经硬编码**，而是由 gateway 原文经
 *   `isContextWindowExceededError(detail)` 判定后赋予（与生产实现
 *   `llm-deepseek/src/adapter.ts:333-345 httpErrorCode()` 的 400 分支同构：命中 ⇒
 *   CONTEXT_WINDOW_EXCEEDED_CODE，否则 'INVALID_REQUEST'）。
 *   ⇒ 若 W2′ 未落地（:68 未收 `is longer than`），本用例的 400 会被判为 INVALID_REQUEST，
 *   overflow 钩子（compaction-basic/src/index.ts:183）早退 ⇒ 救援不发生。用例因此真验 W2′ 全链。
 *
 * 判据口径（R4 定死：一律 meter tokens，`CHARS_PER_TOKEN = 4`）——
 *   · 会话体量 V ∈ (MOCK_REAL_LIMIT_TOKENS, 800_000)：400 必发生，且压力路径不触发；
 *   · 压后重发请求体量 R < MOCK_REAL_LIMIT_TOKENS ⇒ 落「装得下」。
 *   请求体量按 meter 的 `estimateMessage` 逐条计价（消息面 tokens，与 meter 同源口径；
 *   不含请求 header——header 在两侧同口径且远小于本用例量级）。
 *
 * 覆盖范围声明（如实标注）：本用例的 mock 上限为**物理真实上限**（模拟网关 400），
 * 而**非** W1′ 的 effectiveWindow 语义——W1′（容量层）未实施，故此处刻意保留 1e6 虚高，
 * 以验证「仅修识别层」时 overflow 救援是否足以挽回（发布边界裁量的判据来源）。
 *
 * 负向对照实证（2026-09-28 实测，证明本用例非自证式套套逻辑）——
 *   将 `error.ts:68` 临时回退为 W2′ 前形态（`is\s+larger\s+than`）后重跑本用例：
 *   400 被分类为 `INVALID_REQUEST`（非 CONTEXT_WINDOW_EXCEEDED）⇒ overflow 钩子早退
 *   ⇒ 重发次数 = 1、压缩次数 = 0、两例全红（`Tests 2 failed`）。恢复 :68 后复跑全绿。
 *   ⇒ 本用例确实链路级依赖 W2′；W2′ 回退即告警。
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
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'

/** 容量层未修：适配器申报的 1e6 虚高窗（legacy-1e6 语义）。 */
const LEGACY_1E6_CONTEXT_WINDOW = 1_000_000
/** 模拟网关的物理真实上限（tokens）——必须 < 1e6，否则复现不出 400。 */
const MOCK_REAL_LIMIT_TOKENS = 300_000
/** 判据口径的会话体量上界（tokens）。 */
const SESSION_VOLUME_UPPER_BOUND = 800_000

/** 事件留档原文：13bbf5c9（huoshan 网关）turn 179 的 400 报文。 */
const GATEWAY_400_LONGER =
  '400: {"message":"{\\"message\\":\\"The input is longer than the model\'s context length trace_id: bead14916ec206f5451241a41bc3c894\\",\\"type\\":\\"invalid_request_error\\"}\\n","type":"invalid_request_error"}'

/** 网关错误体 → harness 错误码（镜像 llm-deepseek/src/adapter.ts:336-342 的 detail 拼装与 400 分支）。 */
function httpErrorCode(status: number, detail: string): string {
  if (status === 400) {
    return isContextWindowExceededError(detail) ? CONTEXT_WINDOW_EXCEEDED_CODE : 'INVALID_REQUEST'
  }
  return 'SERVER'
}

/**
 * 容量受限的 mock 适配器：申报 1e6 虚高窗，但按**物理真实上限**拒绝过大的请求。
 * 摘要调用（compaction 引擎的摘要请求）按 harness 惯例固定成功——本用例不检验摘要体量 1:1。
 */
class CapacityLimitedAdapter extends LlmAdapter {
  readonly conversationRequests: GenerateOptions[] = []
  readonly summaryRequests: GenerateOptions[] = []
  readonly pricedRequests: number[] = []
  private readonly retryPolicy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 1,
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'a2-4 capacity test provider retryPolicy')

  constructor(
    private readonly priceMessages: (messages: readonly Message[]) => number,
    private readonly alwaysOverflow: boolean,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      // legacy-1e6：容量层虚高未修（W1′ 未实施）。
      context: { contextWindow: LEGACY_1E6_CONTEXT_WINDOW },
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
    if (this.alwaysOverflow || priced > MOCK_REAL_LIMIT_TOKENS) {
      // 真实路径：网关 400 → 分类（W2′ 的 matcher 决定码值）→ 抛错交给 overflow 钩子。
      throw new LlmError(GATEWAY_400_LONGER, httpErrorCode(400, GATEWAY_400_LONGER))
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'recovered' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

/** 大体量历史：4 条消息 × 约 42 万字符 ⇒ 会话体量落在 (MOCK_REAL_LIMIT, 800_000) 区间内。 */
function largeHistorySeed(): SessionEvent[] {
  const session = Session.create(SessionId('overflow-capacity-seed'))
  for (let turn = 1; turn <= 2; turn += 1) {
    const sentinel = turn === 1 ? 'OLD HISTORY SENTINEL' : 'RECENT HISTORY'
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${sentinel} ${'stale context payload '.repeat(20_000)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `historical response ${turn} ${'detail payload '.repeat(20_000)}` }],
        source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  return [...session.events]
}

async function runRecoveryScenario(
  sessionId: string,
  alwaysOverflow: boolean,
): Promise<{
  ctx: Context
  adapter: CapacityLimitedAdapter
  events: SessionEvent[]
  volumeBefore: number
  idleError: unknown
}> {
  const ctx = new Context()
  const adapter = new CapacityLimitedAdapter(
    messages => messages.reduce((total, message) => total + ctx.tokenMeter.estimateMessage(message), 0),
    alwaysOverflow,
  )
  await mountAgentLoopTestDependencies(ctx)
  await mountInvariants(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.on('agent/request', async (_payload, next) => ({
    ...await next(), provider: 'mock', model: 'mock',
  }))
  await ctx.plugin(BasicCompactionEngine, {
    thresholdRatio: 1,
    retainTokens: 100,
    maxTokens: 64,
    compactionRetries: 0,
    maxOverflowRetries: 1,
  })

  const { agent } = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId(sessionId),
    seed: largeHistorySeed(),
    agentOptions: {
      provider: 'unconfigured-agent-fallback',
      model: 'unconfigured-agent-fallback',
    },
  })
  const volumeBefore = ctx.tokenMeter.measure(agent.session).totalTokens
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'continue from history' }],
    source: { kind: 'user' },
  }))
  let idleError: unknown
  try {
    await agent.whenIdle()
  } catch (error) {
    idleError = error
  }
  return { ctx, adapter, events: [...agent.session.events], volumeBefore, idleError }
}

describe('A2④ · W2′-only：容量层虚高（legacy-1e6）下的 overflow 救援', () => {
  it('结局①：真实体量触发 400 ⇒ 一次压缩救援后重发装得下（判据数字入档）', async () => {
    const { ctx, adapter, events, volumeBefore } = await runRecoveryScenario('a2-4-recovery', false)

    // 构造有效性：会话体量 ∈ (mock 真实上限, 800_000) ⇒ 压力路径不触发、400 必发生。
    expect(volumeBefore).toBeGreaterThan(MOCK_REAL_LIMIT_TOKENS)
    expect(volumeBefore).toBeLessThan(SESSION_VOLUME_UPPER_BOUND)

    // 结局①：恰一次压缩 + 恰一次重发。
    expect(adapter.conversationRequests).toHaveLength(2)
    expect(adapter.summaryRequests).toHaveLength(1)

    const firstPriced = adapter.pricedRequests[0]!
    const retriedPriced = adapter.pricedRequests[1]!
    console.log(
      `[A2④ 结局①] 会话体量 V=${volumeBefore} tokens | mock 真实上限=${MOCK_REAL_LIMIT_TOKENS} | `
      + `首请求=${firstPriced}（>上限 ⇒ 400） | 压后重发=${retriedPriced}（<上限 ⇒ 装得下） | `
      + `压后余量=${MOCK_REAL_LIMIT_TOKENS - retriedPriced} tokens`,
    )

    expect(firstPriced).toBeGreaterThan(MOCK_REAL_LIMIT_TOKENS)
    expect(retriedPriced).toBeLessThan(MOCK_REAL_LIMIT_TOKENS)

    // 结构证据：重发请求确实换成了检查点，旧历史已不在请求面。
    const retry = JSON.stringify(adapter.conversationRequests[1]!.messages)
    expect(retry).toContain('RECOVERY CHECKPOINT')
    expect(retry).not.toContain('OLD HISTORY SENTINEL')

    // 压力路径未触发（thresholdRatio:1 ⇒ threshold = 1e6）⇒ 全程只有 overflow 触发的一次压缩。
    const compactionEvents = events.filter(event =>
      event.type === 'compaction/start'
      || event.type === 'compaction/summary'
      || event.type === 'compaction/end',
    )
    expect(compactionEvents.map(event => event.type)).toEqual([
      'compaction/start',
      'compaction/summary',
      'compaction/end',
    ])
    expect(events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'completed' } },
    })

    await ctx.fiber.dispose()
  })

  it('结局②：重发后仍 400 ⇒ 硬停在恰一次重发（maxOverflowRetries=1 耗尽的正确行为）', async () => {
    const { ctx, adapter, events, volumeBefore } = await runRecoveryScenario('a2-4-hard-stop', true)

    console.log(
      `[A2④ 结局②] 会话体量 V=${volumeBefore} tokens | 重发次数=${adapter.conversationRequests.length} | `
      + `压缩次数=${adapter.summaryRequests.length} | 末事件=${JSON.stringify(events.at(-1))}`,
    )

    // 硬停：不出现第 3 次请求（不再无限重试）。
    expect(adapter.conversationRequests).toHaveLength(2)
    expect(adapter.summaryRequests).toHaveLength(1)
    // 会话收束于失败（而非静默继续）。
    expect(events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: { reason: { kind: 'error' } },
    })

    await ctx.fiber.dispose()
  })
})
