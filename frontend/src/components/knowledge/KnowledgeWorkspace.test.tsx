import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { KnowledgeTab } from "./KnowledgeTab";
import { KnowledgePage } from "../../app/routes/KnowledgePage";
import { projectKnowledgeApi, projectMemoryApi, type KnowledgeItem, type SourceReference } from "../../lib/knowledge";
import i18n, { i18nReady } from "../../i18n";

vi.mock("../../lib/workspace", () => ({ useRequiredWorkspaceCwd: () => "/test" }));

function item(id: string, changes: Partial<KnowledgeItem> = {}): KnowledgeItem {
  return {
    id, title: id, summary: `Summary of ${id}`, type: "finding", status: "active",
    confidence: "high", importance: "normal", related_files: [], conflicts_with: [], supersedes: [],
    source: { session_id: null, message_ids: [], files: [], run_ids: [], citations: [] },
    created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z", ...changes,
  };
}

beforeEach(async () => { await i18nReady; await i18n.changeLanguage("en"); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("knowledge evidence", () => {
  it.each<[string, Partial<SourceReference>, string]>([
    ["message", { message_ids: ["message-only"] }, "message-only"],
    ["file", { files: ["data/source.csv"] }, "data/source.csv"],
    ["session", { session_id: "session-only" }, "session-only"],
    ["run", { run_ids: ["run-only"] }, "run-only"],
    ["citation", { citations: ["citation-only"] }, "citation-only"],
    ["structured evidence", { evidence: [{ id: "e1", kind: "artifact", locator: "artifact-only", excerpt: "Measured value 42", line_start: 2, line_end: 4 }] }, "artifact-only"],
  ])("renders %s-only sources without an empty evidence state", (_name, source, text) => {
    const knowledge = item("Evidence item");
    knowledge.source = { ...knowledge.source, ...source };
    render(<KnowledgeTab items={[knowledge]} />);
    const heading = screen.getByRole("heading", { name: "Sources and evidence" });
    const evidence = within(heading.parentElement!);
    expect(evidence.getByText(text)).toBeInTheDocument();
    expect(evidence.queryByText("—")).not.toBeInTheDocument();
    if (source.evidence) {
      expect(evidence.getByText("Measured value 42")).toBeInTheDocument();
      expect(evidence.getByText(":2–4")).toBeInTheDocument();
    }
  });

  it("shows an empty state when every evidence field is empty", () => {
    render(<KnowledgeTab items={[item("No evidence")]} />);
    const heading = screen.getByRole("heading", { name: "Sources and evidence" });
    expect(within(heading.parentElement!).getByText("—")).toBeInTheDocument();
  });

  it("localizes status options in Chinese", async () => {
    await i18n.changeLanguage("zh-Hans");
    render(<KnowledgeTab items={[item("知识")]} />);
    expect(screen.getByRole("option", { name: "已被替代" })).toHaveValue("superseded");
    expect(screen.getByRole("option", { name: "已归档" })).toHaveValue("archived");
  });
});

const mixedItems = [item("Active finding"), item("Active question", { type: "question" }),
  item("Active hypothesis", { type: "hypothesis" }), item("Old finding", { status: "superseded" }),
  item("Old question", { type: "question", status: "superseded" }), item("Archived hypothesis", { type: "hypothesis", status: "archived" })];

function renderPage() {
  vi.spyOn(projectKnowledgeApi, "project").mockResolvedValue({ workspace: "/test", project_file: "PROJECT.md", content: "# Test project", pending_count: 0, knowledge_count: mixedItems.length, auto_review: false });
  vi.spyOn(projectKnowledgeApi, "items").mockResolvedValue({ items: mixedItems });
  vi.spyOn(projectKnowledgeApi, "proposals").mockResolvedValue({ proposals: [], pending_count: 0 });
  vi.spyOn(projectKnowledgeApi, "policy").mockResolvedValue({ auto_review: false } as Awaited<ReturnType<typeof projectKnowledgeApi.policy>>);
  vi.spyOn(projectMemoryApi, "overview").mockResolvedValue({ research_loop_count: 0, run_count: 0, artifact_count: 0 } as Awaited<ReturnType<typeof projectMemoryApi.overview>>);
  render(<KnowledgePage />);
}

it("counts active knowledge and opens the matching default list", async () => {
  renderPage();
  const metric = await screen.findByRole("button", { name: "Accepted knowledge 3" });
  fireEvent.click(metric);
  expect(screen.getByText("3 Knowledge")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Old finding" })).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "all" } });
  expect(screen.getByText("6 Knowledge")).toBeInTheDocument();
});

it("opens active questions and hypotheses together, supports multiple types, and resets ordinary navigation", async () => {
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "Hypotheses and open questions 2" }));
  expect(screen.getByText("2 Knowledge")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Hypothesis" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("button", { name: "Open question" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.queryByRole("heading", { name: "Active finding" })).not.toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Old question" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Finding" }));
  expect(screen.getByText("3 Knowledge")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Hypothesis" }));
  expect(screen.getByText("2 Knowledge")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("tab", { name: "Knowledge" }));
  expect(screen.getByText("3 Knowledge")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "All types" })).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(screen.getByRole("tab", { name: "Overview" }));
  fireEvent.click(screen.getByRole("button", { name: "Accepted knowledge 3" }));
  expect(screen.getByText("3 Knowledge")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "All types" })).toHaveAttribute("aria-pressed", "true");
});
