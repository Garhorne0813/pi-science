import { describe, expect, it } from "vitest";
import type { ToolCallBlock } from "../../../types/thread";
import { projectToolActivity } from "../../../lib/conversation/projection";
import { ActivityRendererRegistry, activityRendererRegistry } from "./registry";

const t = (key: string, values: Record<string, unknown> = {}) => `${key}:${Object.values(values).join(":")}`;
const tool = (name: string, extra: Partial<ToolCallBlock> = {}): ToolCallBlock => ({ kind: "tool", id: name, callId: `${name}-call`, tool: name, status: "done", ...extra });

describe("ActivityRendererRegistry", () => {
  it("selects scientific renderers by projection kind", () => {
    const python = tool("python", { details: { outputs: [{}, {}] } });
    const pubmed = tool("search_pubmed", {
      title: "Running search pubmed",
      details: {
        structuredContent: {
          count: 3,
          total: 3,
          request: { provider: "pubmed", query: "kinase", limit: 3, offset: 0 },
          warnings: [],
          records: [{}, {}, {}],
        },
      },
    });
    const pythonView = activityRendererRegistry.resolve(projectToolActivity(python).kind).compact({ activity: projectToolActivity(python), source: python, live: false, t });
    const pubmedView = activityRendererRegistry.resolve(projectToolActivity(pubmed).kind).compact({ activity: projectToolActivity(pubmed), source: pubmed, live: false, t });
    expect(pythonView).toEqual({ title: "conversation.activity.kernelComplete:Python", detail: "conversation.activity.outputCount:2" });
    expect(pubmedView).toEqual({ title: "PubMed", detail: "conversation.activity.resultCount:3" });
  });

  it("uses paper-search providers and result envelopes for literature metadata", () => {
    const arxiv = tool("search_arxiv", {
      title: "Running search arxiv",
      details: {
        structuredContent: {
          count: 2,
          request: { provider: "arxiv", query: "kinase", limit: 2, offset: 0 },
          records: [{}, {}],
        },
      },
    });
    const arxivView = activityRendererRegistry.resolve(projectToolActivity(arxiv).kind).compact({
      activity: projectToolActivity(arxiv),
      source: arxiv,
      live: false,
      t,
    });
    expect(arxivView).toEqual({ title: "arXiv", detail: "conversation.activity.resultCount:2" });

    const medrxivRunning = tool("search_biorxiv_preprints", {
      status: "running",
      title: "Running search biorxiv preprints",
      input: { server: "medrxiv" },
    });
    const medrxivRunningView = activityRendererRegistry.resolve(projectToolActivity(medrxivRunning).kind).compact({
      activity: projectToolActivity(medrxivRunning),
      source: medrxivRunning,
      live: true,
      t,
    });
    expect(medrxivRunningView.title).toBe("conversation.activity.literatureRunning:medRxiv");

    const medrxiv = tool("search_biorxiv_preprints", {
      input: { server: "medrxiv" },
      details: {
        structuredContent: {
          count: 1,
          request: { provider: "biorxiv", server: "medrxiv", query: "outbreak", limit: 1, offset: 0 },
          records: [{}],
        },
      },
    });
    const medrxivView = activityRendererRegistry.resolve(projectToolActivity(medrxiv).kind).compact({
      activity: projectToolActivity(medrxiv),
      source: medrxiv,
      live: false,
      t,
    });
    expect(medrxivView.title).toBe("medRxiv");

    const fullText = tool("get_europe_pmc_full_text", {
      details: {
        structuredContent: {
          count: 1,
          request: { provider: "europepmc" },
          records: [{}],
        },
      },
    });
    const fullTextView = activityRendererRegistry.resolve(projectToolActivity(fullText).kind).compact({
      activity: projectToolActivity(fullText),
      source: fullText,
      live: false,
      t,
    });
    expect(fullTextView.title).toBe("Europe PMC");
  });

  it("keeps broad research activities out of the literature renderer", () => {
    const grep = tool("grep", {
      title: "Searching for tool.updated",
      presentation: {
        version: 1,
        kind: "search",
        title: "Searching for tool.updated",
        importance: "micro",
        domain: "research",
      },
    });
    expect(projectToolActivity(grep).kind).toBe("file");
    expect([
      "search_pubmed",
      "search_arxiv",
      "search_crossref",
      "search_biorxiv_preprints",
      "get_europe_pmc_full_text",
    ].map((name) => projectToolActivity(tool(name)).kind)).toEqual([
      "literature",
      "literature",
      "literature",
      "literature",
      "literature",
    ]);
  });

  it("preserves semantic titles while adding renderer detail", () => {
    const python = tool("python", {
      title: "Fit Michaelis-Menten model",
      details: { outputs: [{}, {}] },
    });
    const view = activityRendererRegistry.resolve(projectToolActivity(python).kind).compact({
      activity: projectToolActivity(python),
      source: python,
      live: false,
      t,
    });
    expect(view.title).toBe("Fit Michaelis-Menten model");
    expect(view.detail).toContain("Python");
    expect(view.detail).toContain("outputCount:2");
  });

  it("always falls back for unknown renderer keys", () => {
    const registry = new ActivityRendererRegistry();
    const unknown = tool("future_science_tool", { title: "Future analysis" });
    expect(registry.resolve("not-registered").compact({ activity: projectToolActivity(unknown), source: unknown, live: false, t })).toEqual({ title: "Future analysis" });
  });
});
