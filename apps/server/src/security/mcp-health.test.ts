import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeMcpHealth } from "./mcp-health.js";

// probeMcpHealth validates http URLs via validateConnectorOutboundUrl, which
// resolves hostnames with node:dns/promises. Mock DNS so the tests stay
// hermetic and offline CI never depends on real lookups.
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (hostname: string) => {
    if (hostname === "example.com") return [{ address: "93.184.216.34", family: 4 }];
    throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" });
  }),
}));

const cleanups: string[] = [];
const originalHome = process.env.PI_SCIENCE_HOME;

afterEach(() => {
  for (const path of cleanups.splice(0)) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (originalHome === undefined) delete process.env.PI_SCIENCE_HOME;
  else process.env.PI_SCIENCE_HOME = originalHome;
});

function withPathExecutable(name: string): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(tmpdir(), "pi-mcp-health-"));
  cleanups.push(directory);
  writeFileSync(join(directory, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { ...process.env, PATH: directory };
}

describe("probeMcpHealth", () => {
  it("reports missing command or url for an empty definition", async () => {
    const result = await probeMcpHealth({});
    expect(result).toEqual({ health: "error", error: "missing command or url" });
  });

  it("reports a missing stdio executable", async () => {
    const environment = { ...process.env, PATH: "" };
    const result = await probeMcpHealth({ command: "definitely-not-a-real-binary-xyz" }, environment);
    expect(result.health).toBe("error");
    expect(result.error).toContain("command not found");
  });

  it("reports missing required env vars for a stdio server", async () => {
    const environment = withPathExecutable("fake-tool");
    const result = await probeMcpHealth({ command: "fake-tool", required_env: ["API_KEY", "SECRET"] }, environment);
    expect(result).toEqual({ health: "error", error: "missing env: API_KEY" });
  });

  it("reports ok for a complete stdio server", async () => {
    const environment = withPathExecutable("fake-tool");
    const result = await probeMcpHealth({ command: "fake-tool", required_env: ["API_KEY"] }, { ...environment, API_KEY: "set" });
    expect(result).toEqual({ health: "ok", error: null });
  });

  it("reports an invalid or private http URL", async () => {
    await expect(probeMcpHealth({ url: "not-a-url" })).resolves.toMatchObject({ health: "error" });
    const privateResult = await probeMcpHealth({ url: "http://127.0.0.1:9999/" });
    expect(privateResult.health).toBe("error");
    expect(privateResult.error).toContain("private or reserved");
  });

  it("reports missing required env vars for an http server", async () => {
    const result = await probeMcpHealth({ url: "https://example.com/api", required_env: ["PUBMED_KEY"] }, {});
    expect(result).toEqual({ health: "error", error: "missing env: PUBMED_KEY" });
  });

  it("reports ok for a complete http server", async () => {
    const result = await probeMcpHealth({ url: "https://example.com/api", required_env: ["PUBMED_KEY"] }, { PUBMED_KEY: "set" });
    expect(result).toEqual({ health: "ok", error: null });
  });

  it("prefers url probing when both url and command are present", async () => {
    const result = await probeMcpHealth({ url: "http://192.168.1.10/", command: "npx" });
    expect(result.health).toBe("error");
    expect(result.error).toContain("private or reserved");
  });
});
