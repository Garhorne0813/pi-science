import { afterEach, beforeAll, it, expect } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { MemoryRecord } from "@pi-science/contracts";
import i18n from "../../i18n";
import { MemoryHistory } from "./MemoryHistory";
beforeAll(async () => {
  await i18n.changeLanguage("en");
});
afterEach(cleanup);
it("shows the adopted version, review timeline and selected version comparison", () => {
  const old = {
    id: "r",
    scope: "project",
    kind: "finding",
    title: "Result v1",
    body: "Earlier evidence",
    evidenceLevel: "observed",
    sources: [],
    revision: 1,
    contentHash: "one",
    origin: "user_manual",
    status: "pending_review",
    updatedAt: 1000,
  } as unknown as MemoryRecord;
  const current = {
    ...old,
    revision: 2,
    title: "Result v2",
    body: "Later evidence",
    contentHash: "two",
    status: "active" as const,
    updatedAt: 2000,
  };
  render(
    <MemoryHistory
      cwd="project"
      categories={[]}
      current={current}
      data={{
        revisions: [current, old],
        reviews: [
          {
            revision: 2,
            created_at: 2100,
            actor: "local-owner",
            action: "approve",
          },
        ],
      }}
    />,
  );
  expect(screen.getByText("Result v2")).toBeVisible();
  expect(screen.getByText(/Approved this version/)).toBeVisible();
  expect(
    screen.getByText("Advanced data and export").closest("details"),
  ).not.toHaveAttribute("open");
  fireEvent.click(
    screen.getByRole("button", { name: "Compare previous version" }),
  );
  expect(screen.getByText("Earlier")).toBeVisible();
  expect(screen.getByText("Later")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: /Version 1/ }));
  expect(screen.getByText("Result v1")).toBeVisible();
  expect(screen.getByText("Earlier evidence")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "Compare previous version" }),
  ).not.toBeInTheDocument();
});
