/** Deterministic fixture data for the visual regression suite.
 *
 *  Every date is fixed relative to FIXED_NOW so screenshots never drift with
 *  wall-clock time. The mock server (mock-server.mjs) serves these values
 *  over the same /api/* surface the real Node control plane exposes; the
 *  specs set page.clock to FIXED_NOW so rendered relative times match.
 */

export const FIXED_NOW = "2026-08-15T12:00:00.000Z";

export const VISUAL_CWD = "/tmp/visual-demo";
/** Dedicated session-free workspace for the landing hero: the mock server
 *  returns an empty session list for this cwd, so the workspace route can
 *  never auto-navigate into a conversation. */
export const VISUAL_LANDING_CWD = "/tmp/visual-landing";
export const VISUAL_SESSION = "visual-session-1";
export const VISUAL_ACTIVITY_SESSION = "visual-session-2";

export const FIXTURES = {
  workspaces: [
    {
      name: "Visual Demo",
      path: VISUAL_CWD,
      project_id: "proj-visual-demo",
      session_count: 2,
      last_modified: "2026-08-15T10:00:00.000Z",
    },
    {
      name: "Shikimate Project",
      path: "/tmp/shikimate-project",
      project_id: "proj-shikimate",
      session_count: 5,
      last_modified: "2026-08-14T16:30:00.000Z",
    },
  ],

  config: {
    api_keys: { deepseek: true },
    model: "deepseek/deepseek-chat",
    thinking: "medium",
    model_context_window: 64000,
    compaction_enabled: true,
    compaction_threshold_percent: 70,
    allow_private_providers: false,
    providers: [{ id: "deepseek", name: "DeepSeek", models: ["deepseek-chat"], has_key: true }],
    custom_providers: [],
    available_models: [
      {
        id: "deepseek/deepseek-chat",
        provider: "deepseek",
        model: "deepseek-chat",
        label: "DeepSeek Chat",
        custom: false,
        reasoning: false,
        thinking_levels: ["off"],
        capability_source: "fixture",
        context_window: 64000,
      },
      {
        id: "deepseek/deepseek-reasoner",
        provider: "deepseek",
        model: "deepseek-reasoner",
        label: "DeepSeek Reasoner",
        custom: false,
        reasoning: true,
        thinking_levels: ["off", "minimal", "low", "medium", "high"],
        capability_source: "fixture",
        context_window: 64000,
      },
    ],
    model_catalog_source: "fixture",
  },

  sessions: [
    {
      id: VISUAL_SESSION,
      cwd: VISUAL_CWD,
      name: "Markdown rendering demo",
      created_at: "2026-08-15T09:00:00.000Z",
      updated_at: "2026-08-15T11:30:00.000Z",
      project_id: "proj-visual-demo",
    },
    {
      id: "visual-session-2",
      cwd: VISUAL_CWD,
      name: "Data analysis notes",
      created_at: "2026-08-15T08:00:00.000Z",
      updated_at: "2026-08-15T10:00:00.000Z",
      project_id: "proj-visual-demo",
    },
  ],

  /** History for VISUAL_SESSION: user -> bash tool card -> assistant markdown. */
  history: [
    {
      id: "m-user-1",
      role: "user",
      content: [{ type: "text", text: "Load the shikimate pathway measurements from data/shikimate.csv, compute the fold change for each condition, and summarize the three strongest effects." }],
      timestamp: "2026-08-15T09:01:00.000Z",
    },
    {
      id: "m-tool-1",
      role: "toolResult",
      toolCallId: "call-bash-1",
      toolName: "bash",
      content: [{ type: "text", text: "condition,value\nA,12.4\nB,14.1\nC,3.8" }],
      timestamp: "2026-08-15T09:01:30.000Z",
    },
    {
      id: "m-assistant-1",
      role: "assistant",
      content: [
        {
          type: "text",
          text: [
            "# Shikimate pathway analysis",
            "",
            "I loaded `data/shikimate.csv` and computed **fold changes** against the control. The three strongest effects are:",
            "",
            "1. **SAH treatment** — *3.1×* upregulation of chorismate synthase",
            "2. **EPSP block** — *0.4×* downregulation of DAHP synthase",
            "3. **Tryptophan excess** — *2.2×* upregulation of anthranilate phosphoribosyltransferase",
            "",
            "| condition | fold change | p-value |",
            "|---|---:|---:|",
            "| SAH | 3.1 | 0.002 |",
            "| EPSP | 0.4 | 0.011 |",
            "",
            "The full table is attached as `analysis/report.md`. Here is the aggregation script:",
            "",
            "```python",
            "import pandas as pd",
            "",
            'df = pd.read_csv("data/shikimate.csv")',
            'summary = df.groupby("condition")["fold_change"].mean()',
            "print(summary.to_markdown())",
            "```",
            "",
            "> Note: run notebook cell 2 to reproduce the numbers above.",
          ].join("\n"),
        },
      ],
      timestamp: "2026-08-15T09:02:00.000Z",
    },
  ],

  /** Dense tool workflow used to verify attempt history and semantic groups. */
  activityHistory: [
    {
      id: "activity-user",
      role: "user",
      turnId: "activity-turn",
      turnStatus: "completed",
      turnStartedAt: "2026-08-15T10:00:00.000Z",
      turnEndedAt: "2026-08-15T10:00:35.000Z",
      content: [{ type: "text", text: "Inspect the analysis pipeline, update the affected files, and run validation." }],
      timestamp: "2026-08-15T10:00:00.000Z",
    },
    {
      id: "activity-tools",
      role: "assistant",
      turnId: "activity-turn",
      presentationRole: "intermediate",
      content: [
        { type: "toolCall", id: "activity-read-1", name: "read", arguments: { path: "src/pipeline.ts" } },
        { type: "toolCall", id: "activity-grep", name: "grep", arguments: { pattern: "normalizeResults", path: "src" } },
        { type: "toolCall", id: "activity-read-2", name: "read", arguments: { path: "src/results.ts" } },
        { type: "toolCall", id: "activity-edit", name: "edit", arguments: { path: "src/pipeline.ts" } },
        { type: "toolCall", id: "activity-write", name: "write", arguments: { path: "src/results.ts" } },
        { type: "toolCall", id: "activity-test", name: "bash", arguments: { command: "pnpm test -- pipeline", description: "Run pipeline tests" } },
        { type: "toolCall", id: "activity-typecheck", name: "bash", arguments: { command: "pnpm typecheck", description: "Run typecheck" } },
      ],
      timestamp: "2026-08-15T10:00:03.000Z",
    },
    { id: "result-read-1", role: "toolResult", toolCallId: "activity-read-1", toolName: "read", content: [{ type: "text", text: "export function runPipeline() {}" }], timestamp: "2026-08-15T10:00:05.000Z" },
    { id: "result-grep", role: "toolResult", toolCallId: "activity-grep", toolName: "grep", content: [{ type: "text", text: "src/results.ts:42: normalizeResults" }], timestamp: "2026-08-15T10:00:07.000Z" },
    { id: "result-read-2", role: "toolResult", toolCallId: "activity-read-2", toolName: "read", content: [{ type: "text", text: "export const normalizeResults = () => []" }], timestamp: "2026-08-15T10:00:09.000Z" },
    { id: "result-edit", role: "toolResult", toolCallId: "activity-edit", toolName: "edit", content: [{ type: "text", text: "Updated src/pipeline.ts" }], timestamp: "2026-08-15T10:00:14.000Z" },
    { id: "result-write", role: "toolResult", toolCallId: "activity-write", toolName: "write", content: [{ type: "text", text: "Updated src/results.ts" }], timestamp: "2026-08-15T10:00:17.000Z" },
    { id: "result-test-failed", role: "toolResult", toolCallId: "activity-test", toolName: "bash", isError: true, content: [{ type: "text", text: "Error: worker exited before completing the suite" }], timestamp: "2026-08-15T10:00:22.000Z" },
    { id: "result-test-recovered", role: "toolResult", toolCallId: "activity-test", toolName: "bash", content: [{ type: "text", text: "12 tests passed" }], timestamp: "2026-08-15T10:00:28.000Z" },
    { id: "result-typecheck", role: "toolResult", toolCallId: "activity-typecheck", toolName: "bash", content: [{ type: "text", text: "Typecheck passed" }], timestamp: "2026-08-15T10:00:31.000Z" },
    {
      id: "activity-final",
      role: "assistant",
      turnId: "activity-turn",
      turnStatus: "completed",
      turnStartedAt: "2026-08-15T10:00:00.000Z",
      turnEndedAt: "2026-08-15T10:00:35.000Z",
      presentationRole: "final",
      content: [{ type: "text", text: "Validation recovered after one retry. The pipeline changes are ready for review." }],
      timestamp: "2026-08-15T10:00:35.000Z",
    },
  ],

  userMessageIndex: {
    messages: [
      { id: "m-user-1", text: "Load the shikimate pathway measurements from data/shikimate.csv, compute the fold change for each condition, and summarize the three strongest effects.", timestamp: "2026-08-15T09:01:00.000Z", before: "0" },
    ],
    snapshot_version: "fixture-v1",
  },

  activityUserMessageIndex: {
    messages: [{ id: "activity-user", text: "Inspect the analysis pipeline, update the affected files, and run validation.", timestamp: "2026-08-15T10:00:00.000Z", before: "0" }],
    snapshot_version: "fixture-v1",
  },

  sessionState: {
    id: VISUAL_SESSION,
    cwd: VISUAL_CWD,
    is_streaming: false,
    is_compacting: false,
    pending_message_count: 0,
    model: "deepseek/deepseek-chat",
    thinking: "medium",
    context_tokens: 12600,
    context_window: 64000,
    context_percent: 19,
    compaction_enabled: true,
    compaction_threshold_percent: 70,
  },

  files: [
    { path: "README.md", name: "README.md", isDir: false, size: 512, modified: 1755268800000 },
    { path: "data", name: "data", isDir: true, size: 0, modified: 1755268800000 },
    { path: "analysis/report.md", name: "report.md", isDir: false, size: 2048, modified: 1755268800000 },
    { path: "analysis", name: "analysis", isDir: true, size: 0, modified: 1755268800000 },
    { path: "data/shikimate.csv", name: "shikimate.csv", isDir: false, size: 4096, modified: 1755268800000 },
  ],

  artifactTurns: [
    {
      turn_id: "turn-1",
      session_id: VISUAL_SESSION,
      assistant_message_id: "m-assistant-1",
      turn_ordinal: 1,
      ended_at: "2026-08-15T09:02:05.000Z",
      artifacts: [
        { path: "analysis/report.md", kind: "markdown", mime: "text/markdown", size: 2048, artifactId: "a1", version: 1 },
      ],
    },
  ],

  reportMarkdown: [
    "# Fold change report",
    "",
    "Summary of the three strongest effects across all conditions.",
    "",
    "| condition | fold change | p-value |",
    "|---|---:|---:|",
    "| SAH | 3.1 | 0.002 |",
    "| EPSP | 0.4 | 0.011 |",
    "",
    "```python",
    "print(42)",
    "```",
    "",
  ].join("\n"),
};

export function fixedDate(hoursOffset = 0) {
  return new Date(Date.parse(FIXED_NOW) + hoursOffset * 3_600_000).toISOString();
}
