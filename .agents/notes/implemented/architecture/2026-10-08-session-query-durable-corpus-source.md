# Agent Note: Read the session-query corpus from the durable log by default

Status: implemented

English | [中文](2026-10-08-session-query-durable-corpus-source.zh.md)

## Problem

`session-query` resolved a session open in the same process from that Session's in-memory event log. `snapshotLive` cloned every event of that log, and `sourceLive` borrowed it for a batch projection, so any corpus read materialized the whole live array.

That cost grows with conversation length and is now the dominant part of a long-running host's heap. A 2026-10-08 profile of a live instance measured six open sessions holding 4,179,914 events, with one session's 1,362,229 events (about 1,024 JSON bytes each) accounting for roughly 96% of `heapUsed`. Callers that only fold, page, or search the corpus do not need the in-memory copy: the same events are durable.

## Decision

`Config.corpusSource` selects which log one session open in this process is read from. It defaults to `durable`.

- `durable` reads the persisted log for a live id as well, and falls back to the live log when persistence is not mounted, the id has no durable artifact, or the persisted read fails. The resilience property the previous design carried — an unavailable backend never makes history this process already holds unreadable — therefore survives in a stronger form: the corpus prefers the durable log *and* keeps the live fallback.
- `live` restores reading the in-memory log directly, including the preference for an owner that attaches while its persisted prefix is inspected. It is fresher by up to one unflushed write batch, because `append` is best-effort and `flush` is the durability barrier.

The preference applies to both corpus entries: `load` and `projectMany`. Under `durable`, a known live id is routed through the persisted read in the batch path instead of the synchronous live projection, so one batch never materializes a live session's whole log.

## Alternatives considered

Keeping the live preference and bounding the live event array instead was rejected for ordering: that bound needs consumers that no longer read arbitrary old positions, and 72 synchronous history reads across production packages still carry a deferred migration. Moving the corpus to the durable log needs no such prerequisite.

Reading only the durable log, with no live fallback, was rejected because it drops a property the previous design documented: an absent or failing backend would make history held in this process unreadable.

Caching folded corpus values beside the live log was rejected because the durable log already holds the same events, so a second cache would add its own invalidation surface without removing this read.

## Consequences

- A durable corpus answer can lag the live log by up to one unflushed write batch. A deployment that needs the newest tail reads it with `corpusSource: 'live'`.
- The live log stays readable under any persisted-read outcome, so a failing or absent backend removes freshness, not readability.
- A live session that has not materialized is still served from memory: the durable path stops after listing and never inspects a missing artifact.
- The corpus no longer depends on the live array being complete, which is a prerequisite for bounding live-session retention later.
