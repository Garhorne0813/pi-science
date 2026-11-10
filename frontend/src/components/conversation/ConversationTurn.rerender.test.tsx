/** A streamed delta belongs to one turn: the settled turns around it must not
 *  be reconciled again. Counts real AgentActivity calls through the same
 *  renderBlocks path the conversation page uses. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { ThreadBlock } from "../../types/thread";
import type { CodeRunner } from "../markdown-viewer/MarkdownViewer";
import i18n, { i18nReady } from "../../i18n";

const counts = vi.hoisted(() => ({ agentActivity: 0 }));

vi.mock("./AgentActivity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./AgentActivity")>();
  return {
    ...actual,
    AgentActivity: (props: Parameters<typeof actual.AgentActivity>[0]) => {
      counts.agentActivity += 1;
      return actual.AgentActivity(props);
    },
  };
});

import { renderBlocks } from "./ConversationBlocks";
import { buildTurnPresentations } from "../../lib/conversation/turn-presentation";

const codeRunner: CodeRunner = { cwd: "proj", sessionId: "s1" };
const user = (id: string): ThreadBlock => ({ kind: "user", id, text: id, timestamp: "2026-10-01T00:00:00.000Z" });
const final = (id: string): ThreadBlock => ({ kind: "agent", id, presentationRole: "final", parts: [{ id: `${id}-p`, text: id }], timestamp: "2026-10-01T00:00:01.000Z" });
const tool = (id: string, status: "done" | "running" = "done"): ThreadBlock => ({ kind: "tool", id, callId: `${id}-call`, tool: "read", status, startedAt: "2026-10-01T00:00:01.500Z" });
const settled: ThreadBlock[] = [user("u1"), final("a1"), tool("read-1")];
const live: ThreadBlock[] = [user("u2"), final("a2")];
// The fold keeps untouched blocks by reference; only appended deltas are new.
const blocksWith = (delta?: ThreadBlock[]): ThreadBlock[] => [...settled, ...live, ...(delta ?? [])];

beforeAll(async () => { await i18nReady; await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); });

describe("settled turn rendering", () => {
  it("keeps the settled turn presentation referentially stable", () => {
    const before = buildTurnPresentations(blocksWith(), { lastTurnLifecycle: "settled" });
    const after = buildTurnPresentations(blocksWith([tool("read-2", "running")]), { lastTurnLifecycle: "settled" });
    expect(after).toHaveLength(2);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
  });

  it("does not reconcile a settled turn when another turn receives a delta", () => {
    counts.agentActivity = 0;
    const view = render(<div>{renderBlocks(blocksWith(), codeRunner)}</div>);
    const initial = counts.agentActivity;
    expect(initial).toBe(2);
    view.rerender(<div>{renderBlocks(blocksWith([tool("read-2", "running")]), codeRunner)}</div>);
    expect(counts.agentActivity - initial).toBe(1);
  });
});
