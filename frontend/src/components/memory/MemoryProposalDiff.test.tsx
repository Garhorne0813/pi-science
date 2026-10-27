import { afterEach, beforeAll, it, expect } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { MemoryContent } from "@pi-science/contracts";
import i18n from "../../i18n";
import { MemoryProposalDiff } from "./MemoryProposalDiff";
beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);
it("shows metadata and source-version changes even when the body is unchanged", () => {
  const current: MemoryContent = {
    scope: "project",
    kind: "observation",
    title: "Original title",
    body: "Same body",
    categoryId: "old-category",
    evidenceLevel: "observed",
    sources: [
      { kind: "artifact", locator: "a", version: "1", digest: "old-digest" },
    ],
  };
  const candidate: MemoryContent = {
    ...current,
    title: "Changed title",
    kind: "finding",
    categoryId: "new-category",
    evidenceLevel: "inferred",
    sources: [
      { kind: "artifact", locator: "a", version: "2", digest: "new-digest" },
    ],
  };
  render(<MemoryProposalDiff current={current} candidate={candidate} />);
  for (const value of [
    "Original title",
    "Changed title",
    "old-category",
    "new-category",
    "observed",
    "inferred",
  ])
    expect(screen.getByText(value)).toBeVisible();
  expect(screen.getByText(/"version": "1"/)).toHaveTextContent("old-digest");
  expect(screen.getByText(/"version": "2"/)).toHaveTextContent("new-digest");
  expect(screen.getAllByText("Changed")).toHaveLength(5);
});
it("does not invent current content when it cannot be fetched", () => {
  render(
    <MemoryProposalDiff
      candidate={{
        scope: "project",
        kind: "finding",
        title: "Candidate",
        body: "Evidence",
        evidenceLevel: "inferred",
        sources: [],
      }}
    />,
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Current version unavailable",
  );
});
