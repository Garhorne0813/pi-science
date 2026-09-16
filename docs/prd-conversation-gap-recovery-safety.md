# PRD: Lossless Conversation Gap Recovery

## Status

- Target: PR #97 (`feat/progress-visual-settings`)
- Scope: frontend SSE recovery semantics only
- Priority: P1 / merge blocker
- Owner: conversation transport + runtime recovery

## Problem

The current gap-recovery path can silently skip an event because the REST history snapshot and the resume cursor are acquired at different times.

A failing interleaving is:

1. REST history snapshot `S` returns.
2. Event `E` is produced and durably appended after `S`.
3. The client has no registered live subscriber that can receive `E`.
4. The client asks the server for the newest durable cursor and receives the cursor for `E`.
5. The client reconnects from that cursor, so replay starts strictly after `E`.

`E` is now in neither `S` nor the replayed/live stream. The failure is silent because the client never receives `E`, so reducer generation/sequence guards cannot detect it.

There is a second contributor: after `stream.gap`, the transport currently closes the source that delivered the gap and immediately opens a no-cursor EventSource. The server treats a no-cursor subscription as future-only, creating a registration blind spot while the REST snapshot is being rebuilt.

## Product requirement

Conversation recovery must be lossless with respect to the event stream: after a gap, every event must be represented either by the authoritative REST rebase or by a live/replayed SSE event. Recovery must never advance the resume cursor past an event the reducer has not successfully applied.

## Goals

1. Eliminate the snapshot-to-latest-cursor TOCTOU window.
2. Eliminate future-only blind windows during server-declared gap recovery.
3. Preserve existing single-flight REST recovery, session switching, terminal-error handling, and normal cursor-based reconnect performance.
4. Keep the change small enough to safely land in PR #97 without introducing a new server snapshot protocol.

## Non-goals

- Implementing the full Conversation Snapshot v2 endpoint.
- Replacing the existing REST history projection.
- Changing durable event-store retention or compaction policy.
- Removing the existing `/events/cursor` endpoint in this change. It may become dead for gap recovery and can be removed separately after compatibility review.

## Required invariants

### I1 — applied cursor only

The cursor used for recovery must come only from an SSE event that all registered client listeners accepted. Merely receiving an event id is not sufficient.

`receivedEventIds` remains diagnostic/flow-control state. `lastEventIds` remains the reconnect authority.

### I2 — the gap source is a live fence

`ConversationEventHub.subscribe()` registers the subscriber before it performs replay. Therefore, when that replay returns `stream.gap`, the EventSource that receives the gap is already registered for all subsequently published live events.

The client must keep that exact EventSource open while REST gap recovery runs. It must not proactively replace it with a no-cursor source.

### I3 — recovery reconnect cannot jump to server head

Gap recovery must not ask the server for its newest durable cursor and then resume from it. The newest durable record can be newer than the REST snapshot.

`PiScienceClient.getConversationResumeCursor()` must resolve to the transport's last applied cursor instead.

### I4 — no applied cursor must fail safe

If recovery has no applied cursor, reconnecting without `lastEventId` is unsafe because the server treats it as future-only.

In this case the transport must supply a deliberate, valid-shaped, nonexistent cursor (`pi-recovery-sentinel:0`). The server will respond with `stream.gap` only after registering the subscriber, re-establishing a live fence instead of silently attaching at the future edge.

### I5 — fence release is evidence-based

The gap fence may be released when a subsequent SSE event with an id is successfully applied. That event id becomes the new safe reconnect cursor.

Explicit disconnect/session switch/terminal stream teardown also releases the fence because the user or runtime is intentionally abandoning that live source.

## Implementation plan

### 1. `frontend/src/lib/client/sse-transport.ts`

- Add a per-session `gapFencedKey`.
- On `stream.gap`:
  - do not clear the last applied cursor;
  - do not close/reconnect the EventSource;
  - mark the source as gap-fenced;
  - emit the gap to runtime listeners and return.
- While the currently connected source is gap-fenced, same-session `reconnect()` is a no-op.
- When a normal event with an id is successfully applied:
  - advance `lastEventIds`;
  - clear the matching gap fence.
- Add `getRecoveryResumeCursor(cwd, sessionId)`:
  - return the last applied cursor if present;
  - otherwise return `pi-recovery-sentinel:0`.
- Clear the fence on explicit disconnect and terminal stream shutdown.

### 2. `frontend/src/lib/client/pi-science-client.ts`

Keep the existing async public method shape, but make `getConversationResumeCursor()` delegate to `SseTransport.getRecoveryResumeCursor()` instead of the server `/events/cursor` endpoint.

This allows the existing recovery worker to remain unchanged while making its cursor reset/reconnect step safe.

### 3. Regression tests

Update `frontend/src/lib/client/sse-transport.test.ts` to prove:

1. `stream.gap` does not create a second EventSource immediately.
2. The gap source remains connected while recovery requests reconnect.
3. A successfully applied post-gap event releases the fence and becomes the next reconnect cursor.
4. A received-but-rejected event id never becomes a recovery cursor.
5. Recovery with no applied cursor returns the sentinel instead of `null`/no cursor.
6. Existing disconnect-during-gap behavior still wins and does not reopen the session.

## Acceptance criteria

All of the following are required before PR #97 is considered mergeable for this issue:

- [ ] There is no code path in gap recovery that advances the resume cursor to the server's latest durable record.
- [ ] A server-declared `stream.gap` does not proactively close the already-registered source.
- [ ] Same-session reconnect is suppressed only while that active source is the gap fence.
- [ ] The first successfully applied post-gap event advances the safe cursor and restores normal reconnect behavior.
- [ ] A rejected/unapplied event cannot advance the recovery cursor.
- [ ] Recovery with no applied cursor cannot open a future-only no-cursor subscription.
- [ ] Session switch, explicit disconnect, deletion, and terminal errors still close the active source normally.
- [ ] Frontend transport/recovery tests pass.
- [ ] Repository lint, typecheck, tests, build, bundle-budget, and CodeQL checks pass in GitHub Actions.

## Deterministic race model

The correctness argument after this change is:

### Server-declared gap

1. Server registers subscriber `L`.
2. Replay discovers the requested cursor is invalid/missing and sends `stream.gap` through `L`.
3. Client keeps `L` alive and starts REST rebase.
4. If event `E` occurs after step 1, `L` queues/delivers `E`; it cannot fall into a subscribe-registration hole.
5. If the REST snapshot also contains `E`, existing reducer/history reconciliation handles the overlap; duplicate delivery is preferable to silent loss and event identities/revisions provide deduplication semantics.
6. Once `E` is successfully applied, its cursor becomes the new safe replay point.

### Client-detected gap

1. The event that revealed the discontinuity is rejected and does not advance `lastEventIds`.
2. Recovery obtains the last successfully applied cursor.
3. Reconnect replays from that cursor.
4. If no such cursor exists, the sentinel causes the server to emit a registered `stream.gap`, converting the path into the server-declared-gap case above.

## Failure modes and recovery

- **Gap-fenced socket dies before a post-gap event:** native/EventSource or explicit recovery may reconnect using the last applied cursor/sentinel. This can produce another `stream.gap`, but it fails safe and cannot skip unseen events.
- **REST recovery fails:** existing bounded retries and error status remain authoritative; the live fence is not replaced with an unsafe future-only stream.
- **User changes sessions during recovery:** existing generation/session guards invalidate the stale recovery; transport `connect()` releases the previous fence as part of the intentional switch.
- **Terminal session error:** terminal handling clears the fence and closes the source.

## Rollout and observability

No data migration or feature flag is required. Existing `stream.gap`, connection status, runtime recovery logging, and GitHub CI are sufficient for this change. A follow-up can add a counter for repeated gap-fence cycles if production diagnostics need it.

## Definition of done

The change is done when the implementation above is committed to the PR #97 head branch, its focused regression tests are present, a static diff review finds no new unsafe cursor path, and all required GitHub Actions checks for the new head commit are green.
