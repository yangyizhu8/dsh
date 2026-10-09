# Agent Note: Deduplicate a retried prompt request without copying the log

Status: implemented

English | [中文](2026-10-09-session-controller-prompt-dedup-scan.zh.md)

## Problem

`hasPromptRequest` in `api/session-controller` decides whether an incoming prompt RPC request id is already recorded, so a retry is acknowledged instead of appended twice. After the in-memory inbox check it fell back to `agent.session.snapshotEvents().some(...)`.

That fallback pays twice on a long session: the snapshot copies the whole event array before the search starts, and the forward scan begins at the oldest event, so a retried request — whose original sits near the tail — walks the entire log to find it. A live session in this deployment holds up to 1.6M events, so one retried request could copy and scan millions of events.

## Decision

The fallback scans the log newest-first through `eventAt` point reads and stops at the first match. No array is allocated, and the common case — a retry whose original was appended moments ago — resolves after a handful of reads.

The inbox check still runs first, so a request that has not been committed yet is recognized without touching the log.

## Alternatives considered

`snapshotEvents().toReversed().some(...)` was rejected: reversing copies the whole array before the scan, which keeps the allocation and adds one.

Reading the durable log was rejected: a duplicate whose original is not yet flushed would be missed, and the request would be appended a second time.

Bounding the scan to a recent window was rejected: it would silently stop detecting older duplicates, trading a cost problem for a correctness one.

## Consequences

- The fallback allocates nothing and reads at most one event per step until it matches.
- Detection still covers the whole log, so an older duplicate is found; it is only the scan order that changed.
- The read keeps its documented `typescript/no-deprecated` exemption: it is a synchronous history read whose migration is deferred.
