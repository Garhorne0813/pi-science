import { beforeAll, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import i18n from "@/i18n";
import type { ResearchLoopDetail } from "../../lib/knowledge";
import { ResearchDecisionPanel } from "./ResearchDecisionPanel";

beforeAll(async () => { await i18n.changeLanguage("en"); });

it("shows the incumbent, diagnosis and local isolation state", () => {
  const detail = {
    candidates: [{ candidate_id: "c1", proposal: { approach_summary: "faster solver" } }],
    baseline: { speed: 10 },
    execution_isolation: { available: true, backend: "seatbelt" },
    decision: { best_candidate_id: "c1", best_score: 0.2, best_metrics: { speed: 8 }, frontier_candidate_ids: ["c1"], stagnant_rounds: 1, next_strategy: "test vectorization", last_diagnosis: ["CPU bound"], recent_failures: [] },
  } as unknown as ResearchLoopDetail;
  render(<ResearchDecisionPanel detail={detail} />);
  expect(screen.getByText("faster solver")).toBeInTheDocument();
  expect(screen.getByText("test vectorization")).toBeInTheDocument();
  expect(screen.getByText(/Local isolation active/)).toBeInTheDocument();
});
