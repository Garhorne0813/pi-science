import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewUrl, probeLargeFile, readArtifact } from "./files";
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

  it("shares repeated metadata probes for the same workspace path", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      path: "work/result.csv",
      name: "result.csv",
      size: 7,
      is_dir: false,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const [first, second] = await Promise.all([
      probeLargeFile("work/result.csv", "workspace", "/workspace"),
      probeLargeFile("work/result.csv", "workspace", "/workspace"),
    ]);
    const cached = await probeLargeFile("work/result.csv", "workspace", "/workspace");

    expect(first?.path).toBe("work/result.csv");
    expect(second).toEqual(first);
    expect(cached).toEqual(first);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("globally limits concurrent metadata probes across different callers", async () => {
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate;
      active -= 1;
      return new Response(JSON.stringify({ path: String(input), size: 1, is_dir: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const probes = Array.from({ length: 18 }, (_, index) => probeLargeFile(`results/f${index}.csv`, "workspace", "/workspace"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
    expect(maxActive).toBe(6);
    release();
    await Promise.all(probes);
    expect(fetchMock).toHaveBeenCalledTimes(18);
    expect(maxActive).toBe(6);
  });

  it("hands a released probe slot directly to an existing waiter", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return new Response(JSON.stringify({ path: String(input), size: 1, is_dir: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const initial = Array.from({ length: 7 }, (_, index) => probeLargeFile(`handoff/initial-${index}.csv`, "workspace", "/workspace"));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));

    releases.shift()?.();
    const newcomer = probeLargeFile("handoff/newcomer.csv", "workspace", "/workspace");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(7));
    expect(maxActive).toBe(6);

    while (initial.some(() => releases.length > 0) || releases.length > 0) {
      const pending = releases.splice(0);
      if (!pending.length) break;
      pending.forEach((release) => release());
      await Promise.resolve();
    }
    while (releases.length) releases.splice(0).forEach((release) => release());
    await Promise.all([...initial, newcomer]);
    expect(maxActive).toBe(6);
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
