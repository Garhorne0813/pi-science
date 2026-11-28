import { afterEach, describe, expect, it, vi } from "vitest";
import { subscribeWorkspaceFileEvents, workspaceFiles } from "./workspace-files";
import { queryClient } from "../client/query-client";

afterEach(() => {
  queryClient.clear();
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

  it("reloads directory data after invalidation", async () => {
    let version = 1;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      const body = url.startsWith("/api/files/breadcrumbs")
        ? []
        : [{ name: `result-${version}.csv`, path: `result-${version}.csv`, isDir: false, size: 1, modified: version }];
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect((await workspaceFiles.sidebar("/workspace"))[0]?.name).toBe("result-1.csv");
    version = 2;
    expect((await workspaceFiles.sidebar("/workspace"))[0]?.name).toBe("result-1.csv");
    workspaceFiles.invalidate();
    expect((await workspaceFiles.sidebar("/workspace"))[0]?.name).toBe("result-2.csv");
  });

  it("searches the whole workspace with encoded query parameters", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([
      { name: "final report.csv", path: "results/final report.csv", isDir: false, size: 1, modified: 1 },
    ]), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(workspaceFiles.search("/workspace with spaces", "final report")).resolves.toMatchObject([
      { path: "results/final report.csv" },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/files/search?cwd=%2Fworkspace+with+spaces&q=final+report",
      expect.objectContaining({ signal: undefined }),
    );
  });

  it("shares one live file event stream per workspace", () => {
    class FakeEventSource {
      static instances: FakeEventSource[] = [];
      static CLOSED = 2;
      readonly url: string;
      readyState = 0;
      closed = false;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onopen: (() => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      constructor(url: string) { this.url = url; FakeEventSource.instances.push(this); }
      close() { this.closed = true; this.readyState = FakeEventSource.CLOSED; }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = subscribeWorkspaceFileEvents("/workspace A", first);
    const unsubscribeSecond = subscribeWorkspaceFileEvents("/workspace A", second);

    expect(FakeEventSource.instances).toHaveLength(1);
    expect(FakeEventSource.instances[0]?.url).toBe("/api/files/events?cwd=%2Fworkspace%20A");
    FakeEventSource.instances[0]?.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "change", path: "data.csv" }) }));
    expect(first).toHaveBeenLastCalledWith({ type: "change", path: "data.csv" }, false);
    expect(second).toHaveBeenLastCalledWith({ type: "change", path: "data.csv" }, false);

    unsubscribeFirst();
    expect(FakeEventSource.instances[0]?.closed).toBe(false);
    unsubscribeSecond();
    expect(FakeEventSource.instances[0]?.closed).toBe(true);
  });
});
