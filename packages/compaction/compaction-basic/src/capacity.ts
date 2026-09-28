/**
 * Effective context-window resolution for compaction pressure budgets (W1′).
 *
 * W0 found the incident's root cause in this layer: one adapter family declared a
 * virtual 1,000,000-token window for every model it served, and that single number
 * fed both `thresholdTokens` and `retainTokens`, so the pressure path effectively
 * never fired while three sessions died on `400 … context length`. This module owns
 * the resolution chain that replaces that assumption:
 *
 * ```
 * effectiveWindow = min(perModelOverride ?? 归一真窗(model), providerTransferCap(provider) ?? +∞)
 * ```
 *
 * Model ids are normalized to official service ids first (a relay's provider prefix
 * is never a grading criterion), unverified or unknown models fall back to a
 * conservative 262,144-token window, and `contextWindowSource: 'legacy-1e6'` restores
 * the pre-fix virtual window as a one-line rollback.
 *
 * @module @deepseek-ai/dsh-compaction-basic/capacity
 */

/** Which capacity source the pressure budget derives from. */
export type ContextWindowSource = 'effective' | 'legacy-1e6'

/** Conservative window used when a model's real window was not verified. */
export const UNKNOWN_MODEL_CONTEXT_WINDOW = 262_144

/** Virtual window preserved behind the `'legacy-1e6'` rollback switch. */
export const LEGACY_CONTEXT_WINDOW = 1_000_000

/** Default M3 margin (tokens) reserved for one step's maximum increment. */
export const DEFAULT_STEP_INCREMENT_MARGIN_TOKENS = 48_000

/** True window verified against vendor documentation for the DeepSeek families. */
const DEEPSEEK_WINDOW = 1_000_000

interface CatalogEntry {
  readonly contextWindow: number
  /** False when the value is the conservative default pending documentation lookup. */
  readonly verified: boolean
}

/**
 * Verified and conservative windows keyed by official service id (M1 终表).
 *
 * `glm` / `qwen` / `kimi` entries stay unverified: their vendor documentation was not
 * reachable during the audit, so they carry the conservative default and a marker for a
 * later lookup — the per-model `contextWindow` override raises them without a code change.
 */
const MODEL_CATALOG: ReadonlyMap<string, CatalogEntry> = new Map<string, CatalogEntry>([
  ['deepseek-flash', { contextWindow: DEEPSEEK_WINDOW, verified: true }],
  ['deepseek-v4-pro', { contextWindow: DEEPSEEK_WINDOW, verified: true }],
  ['glm-5.3', { contextWindow: UNKNOWN_MODEL_CONTEXT_WINDOW, verified: false }],
  ['glm-5.3-flash', { contextWindow: UNKNOWN_MODEL_CONTEXT_WINDOW, verified: false }],
  ['qwen3.8-flash', { contextWindow: UNKNOWN_MODEL_CONTEXT_WINDOW, verified: false }],
  ['qwen3.8-max', { contextWindow: UNKNOWN_MODEL_CONTEXT_WINDOW, verified: false }],
  ['kimi-k2.7-code', { contextWindow: UNKNOWN_MODEL_CONTEXT_WINDOW, verified: false }],
])

/**
 * Observed relay ids mapped to the official service id that serves them
 * (vendor footnotes: the retired names are accepted but served by DeepSeek-V4.1-Flash).
 */
const SERVICE_ID_ALIASES: ReadonlyMap<string, string> = new Map<string, string>([
  ['deepseek-flash', 'deepseek-flash'],
  ['deepseek-v4-flash', 'deepseek-flash'],
  ['deepseek-v4.1-flash', 'deepseek-flash'],
  ['deepseek-v4-flash-vision-exp', 'deepseek-flash'],
])

/** Where a resolved window came from, for logging and tests. */
export type CapacitySource = 'legacy' | 'override' | 'model-table' | 'conservative-default'

/** One routed target's resolved window plus its provenance. */
export interface CapacityResolution {
  readonly contextWindow: number
  readonly source: CapacitySource
  /** Official service id when normalization succeeded; `undefined` for unknown models. */
  readonly normalizedModelId: string | undefined
  /** True when the window is conservative and the caller should log it once. */
  readonly conservative: boolean
}

/** Capacity inputs after load-time validation. */
export interface CapacityInput {
  readonly contextWindowSource?: ContextWindowSource
  readonly providerTransferCap?: Readonly<Record<string, number>>
  /** Exact per-model override; replaces the true-window leg and may raise or lower it. */
  readonly perModelWindow?: number
}

/**
 * Normalize one observed model id to its official service id.
 * @param model - routed model id as observed (may carry a `vendor/` prefix).
 * @returns the official service id, or `undefined` when it cannot be normalized.
 */
export function normalizeModelId(model: string): string | undefined {
  const trimmed = model.trim().toLowerCase()
  if (trimmed.length === 0) return undefined
  const vendorless = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  const alias = SERVICE_ID_ALIASES.get(vendorless)
  if (alias !== undefined) return alias
  return MODEL_CATALOG.has(vendorless) ? vendorless : undefined
}

/**
 * Resolve the effective window for one routed target.
 * @param provider - routed provider; only used for the relay transfer cap.
 * @param model - routed model id.
 * @param input - validated capacity inputs.
 * @returns the window plus its provenance; the legacy switch ignores overrides and caps.
 */
export function resolveEffectiveWindow(
  provider: string,
  model: string,
  input: CapacityInput = {},
): CapacityResolution {
  const normalizedModelId = normalizeModelId(model)
  if ((input.contextWindowSource ?? 'effective') === 'legacy-1e6') {
    // One-line rollback: the pre-fix virtual window, independent of model and relay.
    return {
      contextWindow: LEGACY_CONTEXT_WINDOW,
      source: 'legacy',
      normalizedModelId,
      conservative: false,
    }
  }

  let resolved: number
  let source: CapacitySource
  let conservative = false
  if (input.perModelWindow !== undefined) {
    resolved = input.perModelWindow
    source = 'override'
  } else {
    const entry = normalizedModelId === undefined ? undefined : MODEL_CATALOG.get(normalizedModelId)
    if (entry !== undefined && entry.verified) {
      resolved = entry.contextWindow
      source = 'model-table'
    } else {
      resolved = UNKNOWN_MODEL_CONTEXT_WINDOW
      source = 'conservative-default'
      conservative = true
    }
  }

  const transferCap = input.providerTransferCap?.[provider]
  const contextWindow = transferCap === undefined ? resolved : Math.min(resolved, transferCap)
  return {
    contextWindow,
    source,
    normalizedModelId,
    conservative: conservative && transferCap === undefined,
  }
}

/**
 * Resolve only the effective window for one routed target.
 * @param provider - routed provider.
 * @param model - routed model id.
 * @param input - validated capacity inputs.
 * @returns the effective window in tokens.
 */
export function effectiveWindow(provider: string, model: string, input: CapacityInput = {}): number {
  return resolveEffectiveWindow(provider, model, input).contextWindow
}
