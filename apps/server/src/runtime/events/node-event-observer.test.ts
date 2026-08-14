import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeNodePiEvent } from "./node-event-observer.js";
import type { PiEvent } from "../pi/pi-process.js";
import { readJsonLines, workspaceFile } from "../../storage/persistence.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-science-observer-"));
  tempDirs.push(path);
  await mkdir(join(path, ".pi-science"), { recursive: true });
  return path;
}

function writeEvent(filePath: string, content: string): PiEvent {
  return { type: "tool_execution_end", toolName: "write", toolCallId: "call-1", args: { file_path: filePath, content }, isError: false } as unknown as PiEvent;
}

function editEvent(filePath: string): PiEvent {
  return { type: "tool_execution_end", toolName: "edit", toolCallId: "call-2", args: { file_path: filePath }, result: { diff: "--- a\n+++ b\n" }, isError: false } as unknown as PiEvent;
}

describe("node event observer artifact manifests", () => {
  it("auto-discovers write/edit artifacts as v2 intermediate manifests", async () => {
    const cwd = await workspace();
    const published: Array<Record<string, unknown>> = [];
    await writeFile(join(cwd, "report.md"), "draft", "utf8");
    await observeNodePiEvent(cwd, "prov/model", writeEvent("report.md", "draft"), "s1", async (payload) => { published.push(payload); });

    const manifests = await readJsonLines<Record<string, unknown>>(workspaceFile(cwd, "artifacts.jsonl"));
    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({
      schema_version: 2, classification: "intermediate", version: 1, path: "report.md",
      inputs: [], supersedes: null, kind: "text",
      producer: { tool: "write", session_id: "s1", model: "prov/model" },
    });
    expect(published).toEqual([expect.objectContaining({ type: "artifact.published", path: "report.md", version: 1 })]);

    // Provenance records still land with artifact linkage.
    const provenance = await readJsonLines<Record<string, unknown>>(workspaceFile(cwd, "provenance.jsonl"));
    expect(provenance).toHaveLength(1);
    expect(provenance[0]).toMatchObject({ tool: "write", artifactVersion: 1, sessionId: "s1" });
  });

  it("does not create a new version when the hash is unchanged", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "data.csv"), "a,b\n", "utf8");
    await observeNodePiEvent(cwd, null, writeEvent("data.csv", "a,b\n"), "s1", async () => undefined);
    await observeNodePiEvent(cwd, null, writeEvent("data.csv", "a,b\n"), "s1", async () => undefined);

    const manifests = await readJsonLines<Record<string, unknown>>(workspaceFile(cwd, "artifacts.jsonl"));
    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toMatchObject({ version: 1, path: "data.csv" });
  });

  it("bumps versions across edits and keeps intermediate classification", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "notes.md"), "v1", "utf8");
    await observeNodePiEvent(cwd, null, writeEvent("notes.md", "v1"), "s1", async () => undefined);
    await writeFile(join(cwd, "notes.md"), "v2 revised", "utf8");
    await observeNodePiEvent(cwd, null, editEvent("notes.md"), "s1", async () => undefined);

    const manifests = await readJsonLines<Record<string, unknown>>(workspaceFile(cwd, "artifacts.jsonl"));
    expect(manifests).toHaveLength(2);
    expect(manifests[1]).toMatchObject({ version: 2, classification: "intermediate", producer: { tool: "edit", session_id: "s1" } });
  });

  it("does not reset the version counter when a verification row for an OLD version is appended last", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "f.txt"), "v1", "utf8");
    await observeNodePiEvent(cwd, null, writeEvent("f.txt", "v1"), "s1", async () => undefined);
    await writeFile(join(cwd, "f.txt"), "v2", "utf8");
    await observeNodePiEvent(cwd, null, writeEvent("f.txt", "v2"), "s1", async () => undefined);

    // Simulate a verify of v1 appending a refreshed OLD-version row at the
    // tail of artifacts.jsonl (the verify route appends rather than rewrites).
    const before = await readJsonLines<Record<string, unknown>>(workspaceFile(cwd, "artifacts.jsonl"));
    const v1 = before.find((item) => item.version === 1)!;
    const { appendJsonLine } = await import("../../storage/persistence.js");
    await appendJsonLine(workspaceFile(cwd, "artifacts.jsonl"), { ...v1, verification: { status: "passed", checked_at: "2026-02-01T00:00:00.000Z" } });

    // A new write must continue at version 3, never collide with the existing
    // version 2 because the tail row happens to be a stale v1 verification.
    await writeFile(join(cwd, "f.txt"), "v3", "utf8");
    await observeNodePiEvent(cwd, null, writeEvent("f.txt", "v3"), "s1", async () => undefined);

    const after = await readJsonLines<Record<string, unknown>>(workspaceFile(cwd, "artifacts.jsonl"));
    expect(after).toHaveLength(4);
    expect(after[3]).toMatchObject({ version: 3, path: "f.txt" });
  });

  it("ignores non-write tools and paths outside the workspace", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "x.txt"), "x", "utf8");
    const runEvent = { type: "tool_execution_end", toolName: "bash", args: {}, isError: false } as unknown as PiEvent;
    await observeNodePiEvent(cwd, null, runEvent, "s1", async () => undefined);
    const escape = { type: "tool_execution_end", toolName: "write", args: { file_path: "../outside.txt" }, isError: false } as unknown as PiEvent;
    await observeNodePiEvent(cwd, null, escape, "s1", async () => undefined);

    const manifests = await readJsonLines<Record<string, unknown>>(workspaceFile(cwd, "artifacts.jsonl"));
    expect(manifests).toHaveLength(0);
  });

  it("records failed tool executions without artifact manifests", async () => {
    const cwd = await workspace();
    await observeNodePiEvent(cwd, null, { type: "tool_execution_end", toolName: "write", args: { file_path: "fail.txt", content: "x" }, isError: true } as unknown as PiEvent, "s1", async () => undefined);
    const manifests = await readJsonLines<Record<string, unknown>>(workspaceFile(cwd, "artifacts.jsonl"));
    expect(manifests).toHaveLength(0);
    // The skill-event line is appended fire-and-forget; poll briefly for it.
    let skillEvents: Array<Record<string, unknown>> = [];
    for (let attempt = 0; attempt < 50; attempt += 1) {
      skillEvents = await readJsonLines<Record<string, unknown>>(workspaceFile(cwd, "skill-events.jsonl"));
      if (skillEvents.some((event) => event.tool === "write" && event.status === "error")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(skillEvents.some((event) => event.tool === "write" && event.status === "error")).toBe(true);
  });
});
