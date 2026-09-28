/**
 * W1′ acceptance · effective-window resolution chain (A3 normalization, A4 zero-change,
 * ④ conservative default, ⑤ switch tri-state).
 *
 * Pure-function coverage of `capacity.ts` plus the derived budgets in `config.ts`, so the
 * acceptance criteria are pinned as numbers rather than inferred from engine behaviour.
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STEP_INCREMENT_MARGIN_TOKENS,
  LEGACY_CONTEXT_WINDOW,
  UNKNOWN_MODEL_CONTEXT_WINDOW,
  effectiveWindow,
  normalizeModelId,
  resolveEffectiveWindow,
} from '@deepseek-ai/dsh-compaction-basic/src/capacity.ts'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
} from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'

/** Convenience: spec numbers for one target under one configuration. */
function specFor(
  config: BasicCompactionConfig,
  provider: string,
  model: string,
): { contextWindow: number; thresholdTokens: number; retainTokens: number } {
  const resolved = resolveConfig(config)
  const policy = resolveTargetPolicy(resolved, { provider, model })
  const window = effectiveWindow(provider, model, {
    contextWindowSource: resolved.contextWindowSource,
    providerTransferCap: resolved.providerTransferCap,
    perModelWindow: policy.contextWindow,
  })
  const spec = resolveCompactSpec(policy, window)
  return {
    contextWindow: spec.contextWindow,
    thresholdTokens: spec.thresholdTokens,
    retainTokens: spec.retainTokens,
  }
}

describe('W1′ · 归一化（A3）', () => {
  it('maps every observed relay id to the official DeepSeek service id', () => {
    expect(normalizeModelId('deepseek/deepseek-v4.1-flash')).toBe('deepseek-flash')
    expect(normalizeModelId('deepseek-v4.1-flash')).toBe('deepseek-flash')
    expect(normalizeModelId('deepseek-v4-flash')).toBe('deepseek-flash')
    expect(normalizeModelId('deepseek-flash')).toBe('deepseek-flash')
    expect(normalizeModelId('deepseek-v4-flash-vision-exp')).toBe('deepseek-flash')
    expect(normalizeModelId('deepseek-v4-pro')).toBe('deepseek-v4-pro')
  })

  it('is not graded by the relay provider prefix', () => {
    const relay = resolveEffectiveWindow('modlens-huoshan-engine', 'deepseek-v4-flash')
    const direct = resolveEffectiveWindow('deepseek-official', 'deepseek-flash')
    expect(relay.contextWindow).toBe(1_000_000)
    expect(direct.contextWindow).toBe(1_000_000)
    expect(relay.source).toBe('model-table')
    expect(relay.conservative).toBe(false)
  })

  it('falls back to the conservative window when normalization fails', () => {
    const resolution = resolveEffectiveWindow('some-relay', 'mystery-model-x')
    expect(normalizeModelId('mystery-model-x')).toBeUndefined()
    expect(resolution.contextWindow).toBe(UNKNOWN_MODEL_CONTEXT_WINDOW)
    expect(resolution.source).toBe('conservative-default')
    expect(resolution.conservative).toBe(true)
  })

  it('keeps documentation-pending families on a conservative window, flagged for follow-up', () => {
    for (const model of ['glm-5.3', 'glm-5.3-flash', 'qwen3.8-flash', 'qwen3.8-max', 'kimi-k2.7-code']) {
      const resolution = resolveEffectiveWindow('any-relay', model)
      expect(resolution.contextWindow).toBe(UNKNOWN_MODEL_CONTEXT_WINDOW)
      expect(resolution.conservative).toBe(true)
      expect(resolution.normalizedModelId).toBe(model)
    }
  })
})

describe('W1′ · 覆盖与中转上限（R3 语义）', () => {
  it('lets an exact override raise a conservative default (post-audit correction path)', () => {
    expect(specFor({
      modelPolicies: [{ provider: 'relay', model: 'glm-5.3', contextWindow: 800_000 }],
    }, 'relay', 'glm-5.3').contextWindow).toBe(800_000)
  })

  it('lets an exact override lower a verified window', () => {
    expect(effectiveWindow('deepseek-official', 'deepseek-flash', {
      perModelWindow: 300_000,
    })).toBe(300_000)
  })

  it('applies a relay cap independently of the override and only lowers it', () => {
    expect(effectiveWindow('capped', 'deepseek-flash', {
      providerTransferCap: { capped: 100_000 },
    })).toBe(100_000)
    // A cap above the resolved window changes nothing.
    expect(effectiveWindow('roomy', 'glm-5.3', {
      providerTransferCap: { roomy: 500_000 },
    })).toBe(UNKNOWN_MODEL_CONTEXT_WINDOW)
    // Override raised above, cap still narrows the result.
    expect(effectiveWindow('capped', 'glm-5.3', {
      perModelWindow: 800_000,
      providerTransferCap: { capped: 400_000 },
    })).toBe(400_000)
  })

  it('ignores overrides and caps under the legacy rollback switch', () => {
    const legacy = resolveEffectiveWindow('capped', 'deepseek-flash', {
      contextWindowSource: 'legacy-1e6',
      perModelWindow: 300_000,
      providerTransferCap: { capped: 100_000 },
    })
    expect(legacy.contextWindow).toBe(LEGACY_CONTEXT_WINDOW)
    expect(legacy.source).toBe('legacy')
    expect(legacy.conservative).toBe(false)
  })
})

describe('W1′ · 派生的压力预算（⑤ 开关三态 + M3 余量）', () => {
  it('defaults to the effective source and leaves bare DeepSeek capacity unchanged', () => {
    const spec = specFor({}, 'deepseek-official', 'deepseek-flash')
    expect(spec.contextWindow).toBe(1_000_000)
    // Identical to the pre-W1′ formula for this target: floor(1e6 × 0.8).
    expect(spec.thresholdTokens).toBe(800_000)
    expect(spec.retainTokens).toBe(160_000)
  })

  it('compresses documentation-pending families much earlier', () => {
    const spec = specFor({}, 'some-relay', 'glm-5.3')
    expect(spec.contextWindow).toBe(UNKNOWN_MODEL_CONTEXT_WINDOW)
    // min(floor(262144 × 0.8) = 209715, 262144 − 48000 = 214144) = 209715
    expect(spec.thresholdTokens).toBe(209_715)
  })

  it('restores the pre-fix virtual budget under the legacy switch', () => {
    const spec = specFor({ contextWindowSource: 'legacy-1e6' }, 'some-relay', 'glm-5.3')
    expect(spec.contextWindow).toBe(1_000_000)
    expect(spec.thresholdTokens).toBe(800_000)
  })

  it('derives threshold, retain and margin from one effective window', () => {
    const spec = specFor({
      thresholdRatio: 0.5,
      modelPolicies: [{ provider: 'relay', model: 'glm-5.3', contextWindow: 800_000 }],
    }, 'relay', 'glm-5.3')
    expect(spec.contextWindow).toBe(800_000)
    // min(400000, 800000 − 48000 = 752000) = 400000 — the margin leg does not bind here.
    expect(spec.thresholdTokens).toBe(400_000)
    expect(spec.retainTokens).toBe(128_000)
  })

  it('lets the margin leg bind when the ratio leaves too little room', () => {
    const spec = specFor({
      thresholdRatio: 1,
      retainRatio: 0.1,
      modelPolicies: [{ provider: 'relay', model: 'glm-5.3', contextWindow: 262_144 }],
    }, 'relay', 'glm-5.3')
    // min(262144, 262144 − 48000) = 214144
    expect(spec.thresholdTokens).toBe(214_144)
  })

  it('falls back to the ratio leg when the window cannot reserve the margin at all', () => {
    const spec = specFor({
      thresholdRatio: 0.5,
      retainTokens: 50,
      modelPolicies: [{ provider: 'tiny', model: 'tiny-model', contextWindow: 400 }],
    }, 'tiny', 'tiny-model')
    expect(spec.contextWindow).toBe(400)
    expect(spec.thresholdTokens).toBe(200)
  })

  it('can disable the margin protection explicitly', () => {
    const spec = specFor({
      thresholdRatio: 1,
      retainRatio: 0.1,
      stepIncrementMarginTokens: 0,
      modelPolicies: [{ provider: 'relay', model: 'glm-5.3', contextWindow: 262_144 }],
    }, 'relay', 'glm-5.3')
    expect(spec.thresholdTokens).toBe(262_144)
    expect(DEFAULT_STEP_INCREMENT_MARGIN_TOKENS).toBe(48_000)
  })
})

describe('W1′ · 配置校验（校验类抛错保留）', () => {
  it('rejects an unknown capacity source', () => {
    expect(() => resolveConfig({ contextWindowSource: 'registry' as never }))
      .toThrow(/contextWindowSource \(registry\) must be one of effective \| legacy-1e6/)
  })

  it('rejects a malformed transfer cap', () => {
    expect(() => resolveConfig({ providerTransferCap: 5 as never }))
      .toThrow(/providerTransferCap must be an object/)
    expect(() => resolveConfig({ providerTransferCap: { relay: 0 } }))
      .toThrow(/providerTransferCap\.relay \(0\) must be a positive integer/)
  })

  it('rejects a malformed margin and override', () => {
    expect(() => resolveConfig({ stepIncrementMarginTokens: -1 }))
      .toThrow(/stepIncrementMarginTokens \(-1\) must be a non-negative integer/)
    expect(() => resolveConfig({
      modelPolicies: [{ provider: 'relay', model: 'glm-5.3', contextWindow: 0 }],
    })).toThrow(/modelPolicies\[0\]\.contextWindow \(0\) must be a positive integer/)
  })

  it('keeps the retention-versus-threshold configuration failure', () => {
    const resolved = resolveConfig({ thresholdRatio: 0.5, retainTokens: 500 })
    const policy = resolveTargetPolicy(resolved, { provider: 'tiny', model: 'tiny-model' })
    expect(() => resolveCompactSpec(policy, 1_000)).toThrow(
      /retainTokens \(500\) must be less than threshold tokens 500/,
    )
  })
})
