import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildScienceEvidence, isReportTurn, scienceReviewPrompt } from "./science-review.js";
import type { ConversationExcerpt } from "./types.js";

const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-science-review-"));
  workspaces.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  return cwd;
}

const excerpt: ConversationExcerpt = {
  session_id: "s1",
  messages: [{ id: "m1", role: "assistant", text: "The analysis is complete." }],
  truncated: false,
};

describe("isReportTurn", () => {
  it("treats long-form output as a report", () => {
    expect(isReportTurn("word ".repeat(400))).toBe(true);
  });

  it("treats citation-dense turns as reports", () => {
    expect(isReportTurn("Prior work 10.1234/a, 10.1234/b and 10.1234/c disagrees.")).toBe(true);
  });

  it("treats artifact-heavy turns as reports", () => {
    expect(isReportTurn("See figures/a.png and reports/out.pdf for details.")).toBe(true);
  });

  it("ignores ordinary chat turns", () => {
    expect(isReportTurn("Done, the file is updated.")).toBe(false);
  });
});

describe("buildScienceEvidence", () => {
  it("reports every citation in the text, including the ones with no snapshot", async () => {
    const cwd = await makeWorkspace();
    await writeFile(join(cwd, ".pi-science/citations.jsonl"), `${JSON.stringify({
      schema: 2, kind: "doi", id: "10.1038/verified", status: "found", title: "Verified Paper", authors: ["Ada Lovelace"], journal: "Nature", year: "2024",
      abstract: "A measured summary of the recorded result.", oa_url: null, retraction: "clear", retraction_note: null, retraction_url: null,
      checked_providers: ["crossref"], record_version: null, status_note: null, verified_at: new Date().toISOString(),
    })}\n`);
    const evidence = await buildScienceEvidence(cwd, "Cites 10.1038/verified, 10.9999/unchecked-one and arXiv:2401.99999v1 here.", "s1");
    expect(evidence).toContain("doi:10.1038/verified [verified] Verified Paper (2024), Nature");
    // The reviewer needs the source's own words, and the limits of them.
    expect(evidence).toContain("A measured summary of the recorded result.");
    expect(evidence).toContain("never that the source supports the sentence citing it");
    // A cached snapshot must never let the other citations disappear from the report.
    expect(evidence).toContain("doi:10.9999/unchecked-one [NOT CHECKED]");
    expect(evidence).toContain("arxiv:2401.99999v1 [NOT CHECKED]");
  });

  it("reports unverified citations and missing executions honestly", async () => {
    const cwd = await makeWorkspace();
    const evidence = await buildScienceEvidence(cwd, "Cites 10.9999/unknown here.", "s1");
    expect(evidence).toContain("have NOT been verified");
    expect(evidence).toContain("no executions were recorded");
  });

  it("includes execution records when present", async () => {
    const cwd = await makeWorkspace();
    const { executionRepository } = await import("../runtime/executions/execution-repository.js");
    const started = await executionRepository.start(cwd, { kind: "kernel_cell", surface: "python", producer: "test", correlation: { session_id: "s1" } });
    await executionRepository.finish(cwd, started.execution_id, { status: "succeeded", producer: "test", result: { stdout_preview: "accuracy=0.91" } });
    const evidence = await buildScienceEvidence(cwd, "plain text", "s1");
    expect(evidence).toContain("kernel_cell/python succeeded");
    expect(evidence).toContain("accuracy=0.91");
  });
});

describe("scienceReviewPrompt", () => {
  it("instructs the four integrity checks and embeds evidence", () => {
    const prompt = scienceReviewPrompt(excerpt, "Verified citation evidence:\n- doi:10.1/x [verified] Paper");
    expect(prompt).toContain("Claims vs execution");
    expect(prompt).toContain("Numbers vs sources");
    expect(prompt).toContain("Citations vs claims");
    expect(prompt).toContain("Plan completion");
    expect(prompt).toContain("<evidence>");
    expect(prompt).toContain("doi:10.1/x");
    expect(prompt).toContain("Return ONLY a JSON array");
  });
});
