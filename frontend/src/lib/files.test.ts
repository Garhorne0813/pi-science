import { afterEach, describe, expect, it, vi } from "vitest";
import { previewUrl, readArtifact, setCurrentCwd } from "./files";


afterEach(() => {
  vi.unstubAllGlobals();
  setCurrentCwd(".");
});


describe("workspace file context", () => {
  it("uses the inspector's explicit cwd instead of stale global route state", async () => {
    setCurrentCwd("/wrong/workspace");
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
});
