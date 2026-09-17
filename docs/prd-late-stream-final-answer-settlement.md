# PRD: Prevent false no-final-answer settlement across recovery and event folding

## Status

Targeted correctness fix for two independent paths that can render a completed turn without its real final answer.

## Problem

The same visible symptom — `Completed · No final answer returned` while useful assistant work exists or the conversation is still progressing — can arise from two different mechanisms.

### 1. Late-stream recovery settles on intermediate commentary

The late-stream recovery monitor can observe an authoritative runtime state that is briefly idle between model/tool phases. It currently treats any assistant history message written after the prompt as proof that the turn produced its reply.

When that persisted assistant message is process commentary (`presentationRole: "intermediate"`), the UI can incorrectly move the turn to `settled` even though the same turn resumes with a search or another tool call moments later.

### 2. Fold state collides when a content-part id is reused by another run

The event fold keeps revision/content state in `textByKey` and `thinkingByKey`. Content-part ids such as `anonymous-N[:part]` are not guaranteed to be unique for the lifetime of the browser Thread. If a later run reuses the exact same content-part key, the fold can read the previous run's revision state or block identity.

Depending on the incoming revision, the later run can then be rejected as stale or can update the earlier run's block, including replacing its `turnId`/`runId`. Once the old final answer is attributed to another turn, the settled-turn structural classifier legitimately reports the original turn as answer-less.

## Goal

Keep live turns live through explicit intermediate commentary, and isolate content folding state when exact part identities are reused across run/turn boundaries.

## Requirements

1. `reconcilePromptAfterLateStream` must continue monitoring when the newest relevant assistant history message has `presentationRole: "intermediate"`.
2. An explicitly final assistant message may continue to confirm the reply using the existing timestamp rule.
3. Legacy assistant history without `presentationRole` must retain the existing timestamp-based confirmation behavior.
4. The existing idle-cap fallback must remain unchanged so a truly finished empty/wedged turn cannot leave Send disabled forever.
5. Fold revision/content state must be owned by the current `runId`, falling back to `turnId`/the active run or turn when necessary. Reuse of the same raw part id by another owner must not read the previous owner's revision or materialization state.
6. V2 stale/speculative revision checks and content reconstruction must see the same owner-scoped state as the legacy fold adapter.
7. Raw `itemId`/`partId` values used by presentation blocks must remain unchanged; run/turn scoping is reducer-internal only.
8. Owner state retained for replay/reconciliation must be bounded so long sessions do not accumulate unbounded reducer metadata.
9. No activity rendering, tool classification, server event protocol, or persisted message schema changes are required.

## Acceptance criteria

- With an idle runtime and only post-prompt intermediate commentary persisted, the turn remains `working`/live.
- When a post-prompt final answer subsequently appears, the monitor settles the turn and resynchronizes history.
- Existing legacy no-role reply recovery continues to settle as before.
- Two V2 runs may emit the exact same content-part id without sharing revision state.
- A later run whose revision restarts at 1 is not rejected as stale because an earlier run used the same part id.
- A later run whose revision happens to continue the earlier run's revision does not append into or re-stamp the earlier run's block when the runs belong to distinct turns.
- The earlier turn keeps its original text, `turnId`, `runId`, and settled final-answer classification.
- Thinking content receives the same cross-run isolation as normal assistant text.

## Test plan

1. Keep the focused late-stream regression: `intermediate -> brief idle -> final`.
2. Add a V2 fold regression with `run-1` and `run-2` reusing the same exact `partId` while the second run restarts its revision. Assert both blocks survive with independent attribution and text.
3. Add a V2 fold regression where the second run's revision/base pair would be accepted against the first run's state if the keys collided. Assert it creates/updates only the second run's block and the first turn retains its final answer.
4. Cover the equivalent repeated-id case for `thinking.updated` so `thinkingByKey` cannot regress independently.
