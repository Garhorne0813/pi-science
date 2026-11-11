import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import i18n from "../../i18n";
import { convertHistoryToBlocks } from "../../lib/agent-runtime/folding/history-conversion";
import type { HistoryMessage } from "../../lib/client/types";
import { AgentActivity } from "./AgentActivity";
import styles from "./AgentActivity.module.css";

const activityCss = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "AgentActivity.module.css"), "utf8");
const progress = { version: 1, scopeId: "cells", scopeLabel: "Indexing files", current: 72, total: 100, unit: "cells", totalKind: "fixed" };

/** Durable history for one settled tool turn: the assistant call carries the
 *  start time, the toolResult carries the end time and the persisted details. */
function settledHistory(toolResult: Pick<HistoryMessage, "details" | "isError">): HistoryMessage[] {
  return [
    { id: "u1", role: "user", content: [{ type: "text", text: "Run the loop" }], timestamp: "2026-11-11T00:00:00.000Z" },
    { id: "m1", role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "python" }], timestamp: "2026-11-11T00:00:01.000Z" },
    { id: "r1", role: "toolResult", toolCallId: "call-1", toolName: "python", content: [{ type: "text", text: "done" }], timestamp: "2026-11-11T00:00:09.000Z", ...toolResult },
    { id: "m2", role: "assistant", content: [{ type: "text", text: "Finished." }], timestamp: "2026-11-11T00:00:10.000Z" },
  ];
}

function renderSettled(messages: HistoryMessage[]) {
  // The caller hands AgentActivity the activity blocks only; user and final
  // answer blocks belong to the surrounding turn.
  const blocks = convertHistoryToBlocks(messages).filter((block) => block.kind === "tool" || block.kind === "thinking" || block.kind === "agent");
  const view = render(<AgentActivity blocks={blocks} lifecycle="settled" hasFinalAnswer turnStartedAt="2026-11-11T00:00:00.000Z" turnEndedAt="2026-11-11T00:00:10.000Z" />);
  // A settled turn starts collapsed; the user opens the summary to review the
  // trace after a reload.
  const summary = view.container.querySelector("button[aria-controls]");
  if (summary) fireEvent.click(summary);
  return view;
}

beforeAll(async () => { await i18n.changeLanguage("en"); });

describe("AgentActivity rebuilt from history", () => {
  it("keeps the frozen layer when a successful tool result carries details.progress", () => {
    const { container } = renderSettled(settledHistory({ details: { progress } }));

    expect(screen.getByText("Indexing files · 72 / 100 cells")).toBeInTheDocument();
    expect(screen.getByText("72%")).toBeInTheDocument();
    expect(container.querySelector('[data-settled="true"]')).not.toBeNull();
    expect(container.querySelector('[data-settled="true"] [style]')).toHaveStyle({ width: "72%" });
    expect(container.querySelector('[role="progressbar"]')).toHaveAttribute("aria-hidden", "true");
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();

    // A reloaded row must not animate to its frozen value: the settled fill
    // uses the settled class, the layer carries data-settled, and the module
    // disables both the width transition and the reveal animation.
    expect((container.querySelector('[data-settled="true"] [style]') as HTMLElement).className).toContain(styles.progressFillSettled);
    expect(activityCss).toMatch(/\.progressFillSettled\s*\{[^}]*transition:\s*none;/);
    expect(activityCss).toMatch(/\.progressLayer\[data-settled="true"\]\s*\{[^}]*animation:\s*none;/);
  });

  it("renders no layer for a thrown tool error whose persisted details lost progress", () => {
    // Known limitation pinned here: bash and notebook rethrow after the error
    // result drops the sentinel (apps/server/src/runtime/agent/worker/tools/sandbox-bash.ts),
    // and agent-core turns that throw into an error toolResult with empty
    // details. History only restores progress from details.progress, so these
    // rows cannot rebuild a layer; MCP error results do retain lastProgress.
    const { container } = renderSettled(settledHistory({ details: { error: "Command failed" }, isError: true }));

    expect(container.querySelector('[data-settled="true"]')).toBeNull();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(container.querySelector("svg.lucide-circle-x")).not.toBeNull();
  });
});
