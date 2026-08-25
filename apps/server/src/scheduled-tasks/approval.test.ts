// Approval scope hash characterization tests (docs §9.4): the hash must move
// when sensitive content moves and stay still when scheduling metadata changes.
import { describe, expect, it } from "vitest";
import type { ScheduledTaskExecutor } from "@pi-science/contracts";
import { approvalCoversCategories, approvalScopeHashPayload, computeApprovalScopeHash } from "./approval.js";

const executor = (overrides: Partial<ScheduledTaskExecutor["config"]> = {}): ScheduledTaskExecutor => ({
  kind: "literature_digest",
  config: {
    query: "CRISPR off-target",
    providers: ["pubmed", "arxiv"],
    instructions: "weekly digest",
    max_results: 30,
    language: "zh-CN",
    ...overrides,
  },
});

describe("computeApprovalScopeHash", () => {
  it("matches a fixed golden value for the canonical payload", () => {
    expect(computeApprovalScopeHash(executor(), "reports/literature")).toBe(
      "dac85e896783a519f7556ebc9c425063e09710bf59981c364c31483157bec585",
    );
  });

  it("is order-insensitive and duplicate-tolerant over providers", () => {
    const sorted = computeApprovalScopeHash(executor({ providers: ["arxiv", "pubmed"] }), "reports/literature");
    const reversed = computeApprovalScopeHash(executor({ providers: ["pubmed", "arxiv"] }), "reports/literature");
    const duplicated = computeApprovalScopeHash(executor({ providers: ["pubmed", "pubmed", "arxiv"] }), "reports/literature");
    expect(reversed).toBe(sorted);
    expect(duplicated).toBe(sorted);
  });

  it("changes when sensitive content changes", () => {
    const baseline = computeApprovalScopeHash(executor(), "reports/literature");
    expect(computeApprovalScopeHash(executor({ query: "CRISPR off-target analysis" }), "reports/literature")).not.toBe(baseline);
    expect(computeApprovalScopeHash(executor({ providers: ["arxiv"] }), "reports/literature")).not.toBe(baseline);
    expect(computeApprovalScopeHash(executor({ max_results: 50 }), "reports/literature")).not.toBe(baseline);
    expect(computeApprovalScopeHash(executor({ language: "en" }), "reports/literature")).not.toBe(baseline);
    expect(computeApprovalScopeHash(executor(), "reports/other")).not.toBe(baseline);
    // Missing instructions normalize to "" instead of splitting one logical scope.
    const absent = computeApprovalScopeHash(executor({ instructions: undefined }), "reports/literature");
    expect(absent).not.toBe(baseline); // baseline carries "weekly digest"
    expect(computeApprovalScopeHash(executor({ instructions: "" }), "reports/literature")).toBe(absent);
  });

  it("emits canonical JSON with exactly the documented keys in order", () => {
    expect(JSON.parse(approvalScopeHashPayload(executor(), "reports/literature"))).toEqual({
      executor_kind: "literature_digest",
      query: "CRISPR off-target",
      providers: ["arxiv", "pubmed"],
      instructions: "weekly digest",
      max_results: 30,
      language: "zh-CN",
      output_relative_root: "reports/literature",
    });
    expect(Object.keys(JSON.parse(approvalScopeHashPayload(executor(), "r")))).toEqual([
      "executor_kind",
      "query",
      "providers",
      "instructions",
      "max_results",
      "language",
      "output_relative_root",
    ]);
  });
});

describe("approvalCoversCategories", () => {
  it("requires exact coverage of every detected category", () => {
    expect(approvalCoversCategories(["personal_data"], ["personal_data"])).toBe(true);
    expect(approvalCoversCategories(["personal_data", "location"], ["personal_data", "location"])).toBe(true);
    expect(approvalCoversCategories(["personal_data", "location"], ["personal_data"])).toBe(true); // superset approval is fine
    expect(approvalCoversCategories(["personal_data"], ["personal_data", "location"])).toBe(false);
    expect(approvalCoversCategories([], [])).toBe(true);
    expect(approvalCoversCategories([], ["personal_data"])).toBe(false);
  });
});
