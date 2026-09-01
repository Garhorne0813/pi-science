import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { autoResearchSnapshotSchema } from "@pi-science/contracts";
import i18n from "@/i18n";
import { useUiStore } from "../../lib/ui";
import { ResearchModePicker, ResearchResultCard } from "./ResearchLoopControls";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("ResearchModePicker", () => {
  it("renders a compact button row", () => {
    render(<ResearchModePicker selected={null} onSelect={vi.fn()} />);

    expect(screen.getByLabelText("Conversation mode")).toHaveClass("pb-1");
    for (const button of screen.getAllByRole("button")) {
      expect(button).toHaveClass("h-7", "min-h-0");
    }
  });
});

describe("ResearchResultCard", () => {
  it("opens the generated Markdown report in the workspace inspector", () => {
    const research = autoResearchSnapshotSchema.parse({
      schema_version: 1,
      research_id: "research-1234567890abcdef",
      project_id: "workspace",
      origin_session_id: null,
      origin_message_id: null,
      revision: 2,
      title: "Report test",
      objective: "Test reports",
      status: "completed",
      constraints: [],
      budget: {},
      usage: {},
      target_metrics: {},
      nodes: [],
      edges: [],
      claims: [],
      evidence: [],
      claim_evidence: [],
      current_activity: null,
      best_result: null,
      report_path: "research-reports/research-1234567890abcdef.md",
      stop_reason: "done",
      created_at: "2026-08-30T00:00:00.000Z",
      updated_at: "2026-08-30T00:01:00.000Z",
      started_at: "2026-08-30T00:00:00.000Z",
      completed_at: "2026-08-30T00:01:00.000Z",
    });

    render(<ResearchResultCard research={research} cwd="/workspace/demo" />);
    fireEvent.click(screen.getByRole("button", { name: "Open report" }));

    expect(useUiStore.getState().inspectorData).toMatchObject({
      variant: "file",
      cwd: "/workspace/demo",
      path: "research-reports/research-1234567890abcdef.md",
      artifact: "report",
      language: "markdown",
    });
  });
});
