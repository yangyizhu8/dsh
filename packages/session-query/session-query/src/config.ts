/** Public configuration and typed failures for the combined session-query service. */

import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Default maximum `before`/`after` raw-event window. */
export const SESSION_QUERY_READ_WINDOW_MAX = 50

/** Default maximum number of concurrent persisted-log reads in one batch read. */
export const SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY = 4

/** Default maximum number of cold prepared-Session observations retained for reuse. */
export const SESSION_QUERY_DEFAULT_PREPARED_SESSION_CACHE_SIZE = 5

/**
 * Where the logical corpus reads a session's events from.
 *
 * `durable` (default) reads the persisted log for every session, including one
 * open in this process, so a long-running reader never materializes a live
 * session's whole in-memory log. It falls back to the live log when the
 * persisted read fails, so an unavailable backend cannot make history that this
 * process already holds unreadable. `live` restores reading an open session's
 * in-memory log directly, which is fresher by up to one unflushed write batch.
 */
export type SessionQueryCorpusSource = 'durable' | 'live'

/** Default corpus source: read the durable log, falling back to the live log on read failure. */
export const SESSION_QUERY_DEFAULT_CORPUS_SOURCE: SessionQueryCorpusSource = 'durable'

/** Backend-independent configuration inherited by every session-query implementation. */
export interface Config {
  /** Maximum accepted raw read context on either side. Defaults to 50. */
  readWindowMax?: number
  /** Maximum concurrent persisted-log reads in one batch read. Defaults to 4. */
  persistedReadConcurrency?: number
  /**
   * Maximum cold prepared-Session observations retained for reuse, keyed by
   * durable revision. Entries pinned by active observation leases do not count
   * against this bound until released. Defaults to 5.
   */
  preparedSessionCacheSize?: number
  /** Corpus read source for sessions open in this process. Defaults to `durable`. */
  corpusSource?: SessionQueryCorpusSource
}

/** Stable machine-routable failure taxonomy for session reads, traces, and search. */
export type SessionQueryErrorCode =
  | 'SESSION_QUERY_ABORTED'
  | 'SESSION_QUERY_CORRUPT_SESSION'
  | 'SESSION_QUERY_EVENT_NOT_FOUND'
  | 'SESSION_QUERY_INDEX_FAILED'
  | 'SESSION_QUERY_INVALID_CONFIG'
  | 'SESSION_QUERY_INVALID_CURSOR'
  | 'SESSION_QUERY_INVALID_FILTER'
  | 'SESSION_QUERY_INVALID_LIMIT'
  | 'SESSION_QUERY_INVALID_QUERY'
  | 'SESSION_QUERY_INVALID_LINEAGE'
  | 'SESSION_QUERY_INVALID_SURFACE'
  | 'SESSION_QUERY_INVALID_WINDOW'
  | 'SESSION_QUERY_PERSISTENCE_FAILED'
  | 'SESSION_QUERY_SEARCH_DISABLED'
  | 'SESSION_QUERY_SESSION_NOT_FOUND'
  | 'SESSION_QUERY_STALE_CURSOR'
  | 'SESSION_QUERY_SOURCE_CONFLICT'

/** Typed session-query failure whose `code` is one closed taxonomy member. */
export class SessionQueryError extends HarnessError {
  declare readonly code: SessionQueryErrorCode

  // The base stores the value; this signature narrows its open string code.
  // oxlint-disable-next-line typescript/no-useless-constructor
  constructor(message: string, code: SessionQueryErrorCode, options?: ErrorOptions) {
    super(message, code, options)
  }
}
