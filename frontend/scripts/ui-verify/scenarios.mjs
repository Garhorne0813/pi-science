/** UI verification scenarios selectable with `pnpm verify:ui --scenario <name>`.
 *  `spec` is relative to frontend/tests/visual; `grep` must match the test title
 *  exactly as Playwright reports it. */

export const SCENARIOS = {
  "conversation-baseline": {
    description: "Settled conversation: user message first, tool cards and markdown, artifact strip anchored to the turn.",
    spec: "conversation.visual.spec.ts",
    grep: "conversation renders with the user message first and the artifact strip anchored to the turn",
  },
};
