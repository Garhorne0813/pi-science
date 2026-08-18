import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewUrl, readArtifact } from "./files";
import { queryClient } from "../client/query-client";


beforeEach(() => {
  queryClient.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  queryClient.clear();
});


describe("workspace file context", () => {
  it("shares concurrent and immediately-following reads for the same preview", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: "work/result.csv",
      encoding: "utf8",
      data: "x,y\n1,2",
      size: 7,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      readArtifact("work/result.csv", "workspace", "/workspace", 8192),
      readArtifact("work/result.csv", "workspace", "/workspace", 8192),
    ]);
    const cached = await readArtifact("work/result.csv", "workspace", "/workspace", 8192);

    expect(first?.data).toBe("x,y\n1,2");
    expect(second).toEqual(first);
    expect(cached).toEqual(first);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the inspector's explicit cwd — the module keeps no ambient workspace state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: "report.docx",
      encoding: "base64",
      data: "AA==",
      size: 1,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await readArtifact("report.docx", undefined, "/correct/workspace");

    expect(String(fetchMock.mock.calls[0][0])).toContain("cwd=%2Fcorrect%2Fworkspace");
    expect(previewUrl("report.pdf", undefined, "/correct/workspace"))
      .toContain("cwd=%2Fcorrect%2Fworkspace");
  });

  it("keeps workspace path separators visible to wildcard file routes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: "drafts/report.md",
      encoding: "utf8",
      data: "# report",
      size: 9,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await readArtifact("drafts/report.md", undefined, "/workspace");

    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/files/drafts/report.md?");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("drafts%2Freport.md");
  });
});
