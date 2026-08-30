import { describe, expect, it } from "vitest";
import { extractScheduledProposal, humanSchedule, interpretScheduledTask } from "./model";

describe("scheduled task proposal interpreter", () => {
  it("interprets a weekday literature monitor without asking for cron", () => {
    const proposal = interpretScheduledTask(
      "Every weekday at 09:00 check PubMed and arXiv for new CRISPR screening papers and only tell me when results are meaningful.",
      "Asia/Shanghai",
      new Date("2026-01-01T00:00:00Z"),
    );
    expect(proposal.schedule.canonical).toEqual({ type: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" });
    expect(proposal.schedule.display_text).toContain("Every weekday · 09:00");
    expect(proposal.providers).toEqual(["pubmed", "arxiv"]);
    expect(proposal.delivery_policy).toBe("only_when_relevant");
  });

  it("classifies unsupported product tasks instead of disguising them as literature", () => {
    expect(interpretScheduledTask("Remind me tomorrow at 09:00 to continue the analysis", "UTC").task_kind).toBe("reminder");
    expect(interpretScheduledTask("Every Friday summarize this research project", "UTC").task_kind).toBe("project_summary");
  });

  it("keeps cron as an implementation detail in the human label", () => {
    expect(humanSchedule({ type: "cron", expression: "0 9 * * 1-5", timezone: "UTC" })).toBe("Every weekday · 09:00 · UTC");
  });

  it("extracts a chat proposal fence without showing its JSON", () => {
    const source = `I prepared this task.\n\n\`\`\`scheduled-task-proposal\n{"proposal_id":"p1","title":"CRISPR watch","task_kind":"literature_monitor","description":"Watch papers","schedule":{"display_text":"Every weekday · 09:00 · UTC","canonical":{"type":"cron","expression":"0 9 * * 1-5","timezone":"UTC"}},"action_summary":"Track CRISPR papers","delivery_policy":"only_when_relevant","query":"CRISPR screening","providers":["pubmed"]}\n\`\`\``;
    const parsed = extractScheduledProposal(source);
    expect(parsed.text).toBe("I prepared this task.");
    expect(parsed.proposal).toMatchObject({ title: "CRISPR watch", delivery_policy: "only_when_relevant" });
  });
});
