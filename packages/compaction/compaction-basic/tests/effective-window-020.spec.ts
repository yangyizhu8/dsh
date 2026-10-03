import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import type { SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'

const SIGNAL = new AbortController().signal
const MODEL = 'test-model'
const TARGET = { provider: 'catalog-provider', model: 'catalog-model' }

class ContextAdapter extends LlmAdapter {
  constructor(private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class RoutedContextAdapter extends LlmAdapter {
  constructor(private readonly windows: Readonly<Record<string, number>>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const contextWindow = this.windows[provider]
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function createContext(contextWindow = 1_000): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  // The registry is a required injection of TokenMeter (its three
  // projection units register in the constructor); mount it synchronously.
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new ContextAdapter(contextWindow))
  return ctx
}

function agent(session: Session): Agent {
  return { session, options: {} } as Agent
}

class TestCompactionEngine extends BasicCompactionEngine {
  summaries = 0

  override async summarize(): Promise<SummaryResult> {
    this.summaries += 1
    return {
      summary: [{ type: 'text', text: 'small checkpoint' }],
      provider: 'summary-provider',
      model: 'summary-model',
    }
  }
}

function service(
  config: BasicCompactionConfig = { auto: false },
  ctx = createContext(),
): TestCompactionEngine {
  return new TestCompactionEngine(ctx, { headroomTokens: 0, maxTokens: 8192, ...config })
}

function pressureCheck(
  compact: BasicCompactionEngine,
  session: Session,
): Promise<CompactionResult | null> {
  return compact.compactIfNeeded(agent(session), 'pressure', SIGNAL)
}

/** Capture the rejection of one pressure pass without running it twice. */
async function pressureFailure(compact: BasicCompactionEngine, session: Session): Promise<unknown> {
  return pressureCheck(compact, session).then(
    () => new Error('expected the pressure path to reject'),
    error => error,
  )
}

/**
 * Closed two-message turns followed by one open turn for durable compaction events.
 */
function conversation(turns = 4, text = 'fixture '.repeat(40).trim()): Session {
  const session = Session.create(SessionId(`conversation-${turns}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: {
          kind: 'model',
          ...{ provider: MODEL, model: MODEL },
        },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

// W1′ effective-window assertion family on the 0.2.0 vendor faces (UPG-020
// Phase 2 WO-06): capacity comes from ctx.llm.resolveModelInfo over the
// adapter-declared catalog window, and a missing window fails loud where the
// 0.1.1 baseline fell back to a conservative 262,144-token window.
describe('effective window budget derivation', () => {
  it('derives threshold, retention, and headroom margin from the declared window', () => {
    const policy = resolveTargetPolicy(resolveConfig({ thresholdRatio: 0.7 }), TARGET)

    // Message budget 100000 − 0 reserved; the default 65536 headroom leaves a
    // 34464 pressure budget that caps the 70000 window fraction; retention
    // floors 0.16 of the 100000 message budget.
    expect(resolveCompactSpec(policy, 100_000, 0)).toEqual({
      target: TARGET,
      contextWindow: 100_000,
      thresholdRatio: 0.7,
      thresholdTokens: 34_464,
      retainTokens: 16_000,
      summarizationProvider: '',
      summarizationModel: '',
      maxTokens: 65_536,
      compactionRetries: 1,
      maxOverflowRetries: 1,
    })
  })

  it('scales the budgets down by the routed output reservation', () => {
    const policy = resolveTargetPolicy(resolveConfig({ thresholdRatio: 0.7 }), TARGET)

    // Message budget 100000 − 8192 = 91808; pressure budget 91808 − 65536 =
    // 26272; retention floor(91808 × 0.16) = 14689.
    expect(resolveCompactSpec(policy, 100_000, 8_192)).toMatchObject({
      contextWindow: 100_000,
      thresholdTokens: 26_272,
      retainTokens: 14_689,
    })
  })

  it('takes the window fraction when headroom leaves it the tighter cap', () => {
    const policy = resolveTargetPolicy(resolveConfig({
      thresholdRatio: 0.7,
      headroomTokens: 4_096,
    }), TARGET)

    // Pressure budget 100000 − 4096 = 95904 stays above the 70000 fraction.
    expect(resolveCompactSpec(policy, 100_000, 0)).toMatchObject({
      thresholdTokens: 70_000,
      retainTokens: 16_000,
    })
  })

  it('gates pressure on the window each provider leg declares for the same model', async () => {
    const ctx = new Context()
    void new LlmRuntime(ctx)
    new SessionProjectionRegistry(ctx)
    void new TokenMeter(ctx)
    const session = conversation(4)
    const measured = ctx.tokenMeter.measure(session).totalTokens
    // The tight leg's floor(0.7 × window) sits at or below the measured
    // pressure; the wide leg's 100k window keeps the threshold far above it.
    ctx.llm.registerAdapter(['tight-leg', 'wide-leg'], new RoutedContextAdapter({
      'tight-leg': Math.floor(measured / 0.7),
      'wide-leg': 100_000,
    }))
    const compact = service({ auto: false, thresholdRatio: 0.7, retainTokens: 180 }, ctx)

    session.append('request/header', {
      header: { config: { provider: 'wide-leg', model: 'shared-id' } },
      reason: 'change',
    })
    await expect(pressureCheck(compact, session)).resolves.toBeNull()
    expect(compact.summaries).toBe(0)
    expect(session.surface.replaceGeneration).toBe(0)

    session.append('request/header', {
      header: { config: { provider: 'tight-leg', model: 'shared-id' } },
      reason: 'change',
    })
    await expect(pressureCheck(compact, session)).resolves.not.toBeNull()
    expect(compact.summaries).toBe(1)
  })
})

describe('missing context capacity fails loud', () => {
  it('rejects pressure compaction when the adapter declares no context capacity', async () => {
    const ctx = createContext()
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation((provider, model) => Promise.resolve({
      provider,
      id: model,
      name: model,
    }))
    const compact = service({ auto: false, thresholdRatio: 0.7, retainTokens: 180 }, ctx)
    const session = conversation(4)

    const failure = await pressureFailure(compact, session)
    expect(failure).toBeInstanceOf(TargetPressureConfigError)
    expect((failure as TargetPressureConfigError).targetKey).toBe(`${MODEL}/${MODEL}`)
    expect((failure as Error).message)
      .toMatch(/no context capacity for test-model\/test-model; configure contextWindow on that adapter model/)
  })
})

describe('window and reservation conflicts', () => {
  it('rejects a reservation larger than the declared window', () => {
    const policy = resolveTargetPolicy(resolveConfig({ thresholdRatio: 0.7 }), TARGET)

    expect(() => resolveCompactSpec(policy, 8_192, 16_384)).toThrow(TargetPressureConfigError)
    expect(() => resolveCompactSpec(policy, 8_192, 16_384))
      .toThrow(/reserves 16384 completion tokens of its 8192-token context window, leaving no message budget/)
  })

  it('rejects a reservation that leaves no pressure budget over headroom', () => {
    const policy = resolveTargetPolicy(resolveConfig({ thresholdRatio: 0.7 }), TARGET)

    // Message budget 100000 − 34464 = 65536 survives, but the default 65536
    // headroom consumes all of it.
    expect(() => resolveCompactSpec(policy, 100_000, 34_464))
      .toThrow(/and 65536 headroom tokens of its 100000-token context window, leaving no pressure budget/)
  })

  it('rejects the routed envelope reservation that exceeds the window', async () => {
    const ctx = createContext(8_192)
    const compact = service({ auto: false, thresholdRatio: 0.7, retainTokens: 180 }, ctx)
    const session = conversation(4)
    session.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL, maxTokens: 16_384 } },
      reason: 'change',
    })

    const failure = await pressureFailure(compact, session)
    expect(failure).toBeInstanceOf(TargetPressureConfigError)
    expect((failure as TargetPressureConfigError).targetKey).toBe(`${MODEL}/${MODEL}`)
    expect((failure as Error).message).toContain('leaving no message budget')
    expect(session.surface.replaceGeneration).toBe(0)
  })

  it.each([0, -1, 1.5])('rejects contextWindow %s that is not a positive integer', (contextWindow) => {
    const policy = resolveTargetPolicy(resolveConfig({ thresholdRatio: 0.7 }), TARGET)

    // The llm service already rejects non-positive adapter-declared windows
    // (INVALID_MODEL_CONTEXT); this pins resolveCompactSpec's own guard for
    // direct spec callers.
    expect(() => resolveCompactSpec(policy, contextWindow, 0)).toThrow(TargetPressureConfigError)
    expect(() => resolveCompactSpec(policy, contextWindow, 0))
      .toThrow(new RegExp(`contextWindow \\(${contextWindow}\\) must be a positive integer`))
  })
})
