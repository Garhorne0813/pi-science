import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { verifyCitationSources } from "./source-verify.js";
import type { CapturedSource } from "./source-capture.js";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }))); });

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-science-citation-verify-"));
  roots.push(root);
  await mkdir(join(root, ".pi-science"), { recursive: true });
  return root;
}

function source(overrides: Partial<CapturedSource> & { identity: string; kind: CapturedSource["kind"] }): CapturedSource {
  return {
    id: `${overrides.kind}:${overrides.identity}`,
    title: overrides.identity,
    locator: { kind: "whole-source" },
    excerpt: null,
    capturedAt: "2026-11-02T02:00:01.000Z",
    evidence: { tool: "read", callId: "c1", turnId: null },
    ...overrides,
  };
}

describe("verifyCitationSources", () => {
  it("verifies a workspace file whose excerpt is still present", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "report.md"), "# Results\n\nAccuracy improved by 4%.\n", "utf8");
    const [verified] = await verifyCitationSources(cwd, [source({ kind: "file", identity: "report.md", excerpt: "Accuracy improved by 4%." })], (path) => readFile(path, "utf8"));
    expect(verified).toMatchObject({ kind: "file", identity: "report.md", status: "verified", statusDetail: null });
  });

  it("reports changed content, missing files and forbidden paths", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "report.md"), "rewritten", "utf8");
    const sources = await verifyCitationSources(cwd, [
      source({ kind: "file", identity: "report.md", excerpt: "old excerpt" }),
      source({ kind: "file", identity: "gone.md", excerpt: "gone" }),
      source({ kind: "file", identity: ".pi-science/state.json", excerpt: "service state" }),
      source({ kind: "file", identity: "../outside.md", excerpt: "escape" }),
    ], (path) => readFile(path, "utf8"));
    expect(sources.map((item) => item.status)).toEqual(["changed", "missing", "forbidden", "forbidden"]);
    expect(sources[0]?.statusDetail).toMatch(/read at answer time/);
    expect(sources[1]?.statusDetail).toMatch(/no longer present/);
    expect(sources[2]?.statusDetail).toBeTruthy();
  });

  it("withholds the excerpt of a source the workspace no longer permits", async () => {
    const cwd = await workspace();
    const sources = await verifyCitationSources(cwd, [
      source({ kind: "file", identity: ".pi-science/state.json", excerpt: "service state" }),
      source({ kind: "file", identity: "../outside.md", excerpt: "escape" }),
    ], (path) => readFile(path, "utf8"));
    expect(sources.map((item) => [item.status, item.excerpt])).toEqual([["forbidden", null], ["forbidden", null]]);
    expect(sources[0]?.statusDetail).toBeTruthy();
  });

  it("marks an interrupted read as an attempt, not as read content", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "report.md"), "text", "utf8");
    const [verified] = await verifyCitationSources(cwd, [source({ kind: "file", identity: "report.md", attempt: true })], (path) => readFile(path, "utf8"));
    expect(verified).toMatchObject({ status: "unavailable", excerpt: null });
    expect(verified?.statusDetail).toMatch(/did not complete/);
  });

  it("marks sources without an excerpt as unavailable, including binary captures", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "scan.pdf"), "%PDF-1.7", "utf8");
    const sources = await verifyCitationSources(cwd, [
      source({ kind: "file", identity: "scan.pdf", binary: true }),
      source({ kind: "file", identity: "report.md" }),
    ], (path) => readFile(path, "utf8"));
    expect(sources[0]).toMatchObject({ status: "unavailable", excerpt: null });
    expect(sources[0]?.statusDetail).toMatch(/Binary source/);
    expect(sources[1]).toMatchObject({ status: "missing" });
  });

  it("skips files larger than 8 MB", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "big.csv"), Buffer.alloc(9 * 1024 * 1024, 65));
    const read = vi.fn(async (path: string) => readFile(path, "utf8"));
    const [source8mb] = await verifyCitationSources(cwd, [source({ kind: "file", identity: "big.csv", excerpt: "AAAA" })], read);
    expect(source8mb).toMatchObject({ status: "unavailable" });
    expect(source8mb?.statusDetail).toMatch(/8 MB/);
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps web evidence from the fetch and never reads local files for it", async () => {
    const cwd = await workspace();
    const read = vi.fn(async (path: string) => readFile(path, "utf8"));
    const sources = await verifyCitationSources(cwd, [
      source({ kind: "web", identity: "https://example.org/a", title: "example.org", excerpt: "Findings", evidence: { tool: "web_fetch", callId: "c2", turnId: null } }),
      source({ kind: "web", identity: "https://example.org/b", title: "example.org" }),
      source({ kind: "web", identity: "https://example.org/c", title: "example.org", binary: true }),
    ], read);
    expect(sources.map((item) => item.status)).toEqual(["verified", "unavailable", "unavailable"]);
    expect(sources[0]?.statusDetail).toMatch(/live page may have changed/);
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps identifiers as identifier-only without touching the workspace", async () => {
    const cwd = await workspace();
    const sources = await verifyCitationSources(cwd, [
      source({ kind: "doi", identity: "10.1000/xyz" }),
      source({ kind: "arxiv", identity: "2401.12345" }),
    ]);
    expect(sources.map((item) => item.status)).toEqual(["identifier-only", "identifier-only"]);
    expect(sources[0]?.statusDetail).toBeTruthy();
  });
});
