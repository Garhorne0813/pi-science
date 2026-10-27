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
      {
        kind: "artifact",
        locator: "a",
        version: "1",
        digest: "old-digest",
        projectId: "project-before",
      },
    ],
  };
  const candidate: MemoryContent = {
    ...current,
    title: "Changed title",
    kind: "finding",
    categoryId: "new-category",
    evidenceLevel: "inferred",
    sources: [
      {
        kind: "artifact",
        locator: "a",
        version: "2",
        digest: "new-digest",
        projectId: "project-after",
      },
    ],
  };
  render(<MemoryProposalDiff current={current} candidate={candidate} />);
  for (const value of [
    "Original title",
    "Changed title",
    "old-category",
    "new-category",
    "Observed",
    "Inferred",
  ])
    expect(screen.getByText(value)).toBeVisible();
  expect(screen.getByText("Version 1")).toBeVisible();
  expect(screen.getByText("Version 2")).toBeVisible();
  expect(screen.getAllByText("old-digest")[0]).toBeVisible();
  expect(screen.getAllByText("new-digest")[0]).toBeVisible();
  expect(screen.getByText(/Source project changed/)).toBeVisible();
  expect(screen.getAllByText(/project-before/)[0]).toBeVisible();
  expect(screen.getAllByText(/project-after/)[0]).toBeVisible();
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
it("keeps unchanged content collapsed and shows only the exact text edit and named category changes", () => {
  const current: MemoryContent = {
    scope: "project",
    kind: "finding",
    title: "Result",
    body: "A 😀 result.",
    evidenceLevel: "observed",
    categoryId: "a",
    sources: [],
  };
  render(
    <MemoryProposalDiff
      current={current}
      candidate={{ ...current, body: "A 😀 revised result.", categoryId: "b" }}
      categories={[
        { id: "a", name: "Methods" },
        { id: "b", name: "Findings" },
      ]}
    />,
  );
  expect(screen.getByText("Methods")).toBeVisible();
  expect(screen.getByText("Findings")).toBeVisible();
  expect(document.querySelector("ins")).toHaveTextContent("revised");
  expect(screen.getAllByText("Result")[0]).not.toBeVisible();
  const fullText = document.querySelector("ins")?.parentElement?.textContent;
  expect(fullText).toBe("A 😀 revised result.");
});
