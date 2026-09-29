import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workspaceFile } from "../storage/persistence.js";
import { fetchDownloadHop } from "./download-egress.js";
import { downloadUrl, grantDownloadHost, NetworkAccessRequired } from "./download-service.js";

vi.mock("./download-egress.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./download-egress.js")>();
  return { ...original, fetchDownloadHop: vi.fn() };
});

let root: string;
let workspace: string;
let previousRoot: string | undefined;
let previousHome: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pi-download-test-"));
  workspace = join(root, "project");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  previousRoot = process.env.PI_SCIENCE_WORKSPACES;
  previousHome = process.env.PI_SCIENCE_HOME;
  process.env.PI_SCIENCE_WORKSPACES = root;
  process.env.PI_SCIENCE_HOME = join(root, "state");
  vi.mocked(fetchDownloadHop).mockReset();
});
afterEach(async () => {
  if (previousRoot === undefined) delete process.env.PI_SCIENCE_WORKSPACES;
  else process.env.PI_SCIENCE_WORKSPACES = previousRoot;
  if (previousHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

describe("controlled downloads", () => {
  it("requires a host grant before opening a connection and publishes a complete artifact", async () => {
    const input = { workspace, sessionId: "session-one", url: "https://files.rcsb.org/download/4HHB.cif", destination: "structures/4HHB.cif" };
    await expect(downloadUrl(input)).rejects.toBeInstanceOf(NetworkAccessRequired);
    expect(fetchDownloadHop).not.toHaveBeenCalled();
    await grantDownloadHost(workspace, input.sessionId, input.url);
    vi.mocked(fetchDownloadHop).mockResolvedValue(new Response("data_test\n", { status: 200 }) as any);
    const result = await downloadUrl(input);
    expect(result).toMatchObject({ destination: input.destination, size: 10, artifact_version: 1 });
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(workspace, input.destination), "utf8")).toBe("data_test\n");
    const manifests = (await readFile(workspaceFile(workspace, "artifacts.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    expect(manifests.at(-1)).toMatchObject({ producer: { tool: "download_url" }, inputs: [{ final_url: input.url, sha256: result.sha256 }] });
  });

  it("checks every redirect host independently", async () => {
    const input = { workspace, sessionId: "session-two", url: "https://files.rcsb.org/a", destination: "a.cif" };
    await grantDownloadHost(workspace, input.sessionId, input.url);
    vi.mocked(fetchDownloadHop).mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://other.example/b" } }) as any);
    await expect(downloadUrl(input)).rejects.toMatchObject({ code: "network_access_required", host: "other.example" });
    expect(fetchDownloadHop).toHaveBeenCalledTimes(1);
  });

  it("rejects reserved and symlink destinations", async () => {
    const input = { workspace, sessionId: "session-three", url: "https://files.rcsb.org/a", destination: ".pi-science/a" };
    await grantDownloadHost(workspace, input.sessionId, input.url);
    await expect(downloadUrl(input)).rejects.toThrow(/metadata/);
    await symlink(root, join(workspace, "linked"));
    await expect(downloadUrl({ ...input, destination: "linked/a" })).rejects.toThrow();
    expect(fetchDownloadHop).not.toHaveBeenCalled();
  });

  it("drops oversized responses without publishing a destination", async () => {
    const input = { workspace, sessionId: "session-four", url: "https://files.rcsb.org/a", destination: "large.cif", maxBytes: 2 };
    await grantDownloadHost(workspace, input.sessionId, input.url);
    vi.mocked(fetchDownloadHop).mockResolvedValue(new Response("12345", { status: 200 }) as any);
    await expect(downloadUrl(input)).rejects.toThrow(/size limit/);
    await expect(readFile(join(workspace, "large.cif"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
