# Agent Note: Serve the session title snapshot from its projection unit

Status: implemented

English | [中文](2026-10-08-session-title-projection-snapshot.zh.md)

## Problem

`SessionTitleService.get` folded the whole log on every call: `foldSessionTitle(session.snapshotEvents())`. A host that reads a title repeatedly therefore re-scanned the session's entire event array each time, and the read carried a deferred synchronous history read.

The package already registered a `title` projection unit, but its state held only the title **text**, so `get` could not serve its snapshot — the title plus `messageSeqs`, `source`, `eventSeq`, and `updatedAt` — from projected state. The unused `TitleProjection = SessionTitleSnapshot` alias in `src/types.ts` records that the richer state was the intended shape.

## Decision

The `title` unit's state becomes the whole snapshot payload (`TitleProjection | null`) and its `stateVersion` moves from 1 to 2. Its `apply` builds that payload from one `session/title` event and returns the same state reference for every other event, so an unrelated append still produces no downstream work.

`get` now reads `stateOf(session, 'title')` and rebuilds the snapshot through `titleSnapshotFromState`, the same constructor the fold used, so equivalence holds by construction rather than by a re-implemented fold. A session's first read folds once over its log and every later read continues from the unit's watermark.

The wire view stays the bare title text, so projection consumers see no change.

`collectSessionTitleMessages` keeps scanning the log for one provider generation: the eligible prefix is materialized only when a provider runs, which is why the bounded `titleInput` aggregate exists beside it.

## Alternatives considered

Registering a second unit for the payload was rejected: it would fold the same event twice, add a second persisted row, and split one fact across two authorities.

Reading the state through `checkpoint` was rejected: that call structured-clones every registered unit's state on each read, while `stateOf` materializes the same cells and returns the live state, which this read only copies.

Leaving `get` on the log scan was rejected: it re-reads the whole log per call and keeps a synchronous history read the projection seam already replaces.

## Consequences

- Rows persisted by the version-1 unit are discarded instead of forward-applied, so the first title read after an upgrade refolds that session's log once. A discarded row is a cache miss, never a wrong title.
- The wire contract is unchanged: `title` remains the title text.
- `foldSessionTitle` stays the pure whole-array fold for callers that hold events rather than a session.
