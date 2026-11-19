import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadWorkspaceFile } from "./file-download";

const createObjectURL = vi.fn((_blob: Blob) => "blob:workspace-file");
const revokeObjectURL = vi.fn();
const clicks: { href: string | null; download: string }[] = [];

const bytes = () => new Response("raw bytes");

describe("downloadWorkspaceFile", () => {
  beforeEach(() => {
    clicks.length = 0;
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicks.push({ href: this.getAttribute("href"), download: this.download });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("requests the served bytes with both the path and the cwd encoded", async () => {
    const fetchMock = vi.fn(async () => bytes());
    vi.stubGlobal("fetch", fetchMock);

    await downloadWorkspaceFile("/home/user/my workspace", "reports/q1 data.csv", "q1 data.csv");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/files/serve/reports/q1%20data.csv?cwd=%2Fhome%2Fuser%2Fmy+workspace");
    expect(init.credentials).toBe("include");
  });

  it("saves the response under the entry's own name and releases the object URL", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => bytes()));

    await downloadWorkspaceFile("/ws", "reports/q1 data.csv", "q1 data.csv");

    expect(clicks).toEqual([{ href: "blob:workspace-file", download: "q1 data.csv" }]);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    await expect((createObjectURL.mock.calls[0]![0] as Blob).text()).resolves.toBe("raw bytes");
    await vi.waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith("blob:workspace-file"));
  });

  it("surfaces the server's error message and saves nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "Unable to read file: missing.csv" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )));

    await expect(downloadWorkspaceFile("/ws", "missing.csv", "missing.csv"))
      .rejects.toThrow("Unable to read file: missing.csv");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clicks).toHaveLength(0);
  });

  it("falls back to the status when a failure body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "<html>oops</html>",
      { status: 500, headers: { "Content-Type": "text/html" } },
    )));

    await expect(downloadWorkspaceFile("/ws", "broken.csv", "broken.csv"))
      .rejects.toThrow("Download failed (HTTP 500)");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clicks).toHaveLength(0);
  });

  it("propagates network failures without starting a download", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    }));

    await expect(downloadWorkspaceFile("/ws", "note.csv", "note.csv")).rejects.toThrow("Failed to fetch");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(clicks).toHaveLength(0);
  });
});
