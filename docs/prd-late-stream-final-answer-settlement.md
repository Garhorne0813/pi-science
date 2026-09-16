# PRD: Prevent intermediate commentary from settling a late-stream turn

## Status

Minimal bug fix.

## Problem

The late-stream recovery monitor can observe an authoritative runtime state that is briefly idle between model/tool phases. It currently treats any assistant history message written after the prompt as proof that the turn produced its reply.

When that persisted assistant message is process commentary (`presentationRole: "intermediate"`), the UI can incorrectly move the turn to `settled`. `AgentActivity` then renders the terminal summary, including “No final answer returned”, even though the same turn resumes with a search or another tool call moments later.

## Goal

Do not settle a live turn from late-stream recovery when the newest post-prompt assistant history message is explicitly intermediate commentary.

## Requirements

1. `reconcilePromptAfterLateStream` must continue monitoring when the newest relevant assistant history message has `presentationRole: "intermediate"`.
2. An explicitly final assistant message may continue to confirm the reply using the existing timestamp rule.
3. Legacy assistant history without `presentationRole` must retain the existing timestamp-based confirmation behavior.
4. The existing idle-cap fallback must remain unchanged so a truly finished empty/wedged turn cannot leave Send disabled forever.
5. No activity rendering, tool classification, SSE terminal-event semantics, or server protocol changes are in scope.

## Acceptance criteria

- With an idle runtime and only post-prompt intermediate commentary persisted, the turn remains `working`/live.
- When a post-prompt final answer subsequently appears, the monitor settles the turn and resynchronizes history.
- Existing legacy no-role reply recovery continues to settle as before.

## Test plan

Add a regression test that reproduces this sequence:

1. Send a prompt.
2. Runtime state is idle during the monitor probe.
3. History contains a new assistant message marked `intermediate`.
4. Verify the turn is still working after the first probe.
5. History then contains a new assistant message marked `final`.
6. Verify the turn settles and the final answer is restored.
