import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatFileSize,
  groupKnowledgeItems,
  projectKnowledgeApi,
  type KnowledgeItem,
} from "./project-knowledge";


function item(id: string, type: KnowledgeItem["type"]): KnowledgeItem {
  return {
    id,
    type,
    title: id,
    summary: `${id} summary`,
    confidence: "high",
    importance: "normal",
    status: "active",
    source: { message_ids: [], files: [], run_ids: [], citations: [] },
    related_files: [],
    conflicts_with: [],
    supersedes: [],
    created_at: "2026-07-15T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
  };
}


afterEach(() => {
  vi.unstubAllGlobals();
});


describe("project knowledge helpers", () => {
  it("groups accepted knowledge by semantic type", () => {
    const groups = groupKnowledgeItems([
      item("finding-1", "finding"),
      item("decision-1", "decision"),
      item("finding-2", "finding"),
    ]);

    expect(groups.finding.map((entry) => entry.id)).toEqual(["finding-1", "finding-2"]);
    expect(groups.decision[0].id).toBe("decision-1");
  });

  it("formats file sizes for logical file views", () => {
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("project knowledge API", () => {
  it("sends explicit approval before accepting a proposal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await projectKnowledgeApi.accept("/tmp/project one", "proposal-1", {
      title: "Reviewed title",
      summary: "Reviewed summary",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/api/project-knowledge/proposals/proposal-1/accept");
    expect(url).toContain("cwd=%2Ftmp%2Fproject+one");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ title: "Reviewed title", summary: "Reviewed summary" });
  });

  it("surfaces backend safety errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      detail: "target exists: data/result.csv",
    }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    })));

    await expect(projectKnowledgeApi.undo("/tmp/project", "fileop-1"))
      .rejects.toThrow("target exists: data/result.csv");
  });

  it("starts Reviewer with the active session and no direct mutation flag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      run_id: "review-1",
      created: 1,
      skipped: 0,
      proposal_ids: ["proposal-1"],
      message: "Created 1 proposal",
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await projectKnowledgeApi.review("/tmp/project", "session-1");

    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(init.body)).toMatchObject({
      cwd: "/tmp/project",
      session_id: "session-1",
      include_files: true,
      force_full_session: false,
    });
  });
});
