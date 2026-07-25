import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceFiles } from "./workspace-files";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace files", () => {
  it("formats file sizes consistently across presentations", () => {
    expect(workspaceFiles.formatSize(900)).toBe("900 B");
    expect(workspaceFiles.formatSize(1536)).toBe("1.5 KB");
    expect(workspaceFiles.formatSize(2 * 1048576)).toBe("2.0 MB");
  });

  it("shares a directory load without letting one cancelled observer abort the request", async () => {
    let releaseRequests!: () => void;
    const requestsReleased = new Promise<void>((resolve) => { releaseRequests = resolve; });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      await Promise.race([
        requestsReleased,
        new Promise<never>((_, reject) => init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        )),
      ]);
      const url = String(input);
      const body = url.startsWith("/api/files/breadcrumbs")
        ? [{ name: "reports", path: "reports" }]
        : [{ name: "result.csv", path: "reports/result.csv", isDir: false, size: 42, modified: 1 }];
      return new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const cancelledObserver = new AbortController();
    const first = workspaceFiles.directory("/tmp/shared-workspace", "reports", cancelledObserver.signal);
    const second = workspaceFiles.directory("/tmp/shared-workspace", "reports");
    cancelledObserver.abort();
    releaseRequests();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).resolves.toMatchObject({
      entries: [{ name: "result.csv" }],
      breadcrumbs: [{ name: "reports" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
