import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MEMORY_LEDGER_VERSION,
  migrateProjectStateMemory,
  projectMemoryLedgerPath,
  readMemoryLedger,
} from "./ledger.js";

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
});

function legacyState() {
  return {
    items: [{
      id: "knowledge-1",
      type: "finding",
      title: "Buffer pH drifts",
      summary: "The buffer drifts after four hours.",
      confidence: "high",
      importance: "important",
      status: "active",
      source: { session_id: "session-a", message_ids: ["message-1"], files: ["notes.md"], run_ids: ["run-1"], citations: ["doi:10.1/example"] },
      related_files: ["notes.md"],
      conflicts_with: [],
      supersedes: [],
      proposal_id: "proposal-1",
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    }],
    proposals: [{
      id: "proposal-1",
      proposal_type: "knowledge",
      knowledge_type: "finding",
      type: "finding",
      title: "Buffer pH drifts",
      summary: "The buffer drifts after four hours.",
      reason: "Observed twice.",
      confidence: "high",
      importance: "important",
      status: "accepted",
      source: { session_id: "session-a", message_ids: ["message-1"], files: ["notes.md"], run_ids: [], citations: [] },
      related_files: ["notes.md"],
      conflicts_with: [],
      supersedes: [],
      operations: [],
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    }, {
      id: "proposal-2",
      proposal_type: "knowledge",
      knowledge_type: "decision",
      type: "decision",
      title: "Use fresh buffer",
      summary: "Prepare buffer before each run.",
      reason: "Reduces drift.",
      confidence: "medium",
      importance: "normal",
      status: "pending",
      source: { session_id: "session-a", message_ids: ["message-2"], files: [], run_ids: [], citations: [] },
      related_files: [],
      conflicts_with: [],
      supersedes: [],
      operations: [],
      created_at: "2026-08-01T00:00:00.000Z",
      updated_at: "2026-08-01T00:00:00.000Z",
    }],
  };
}

describe("memory ledger", () => {
  it("migrates project items and proposals while deriving evidence refs", () => {
    const ledger = migrateProjectStateMemory(legacyState(), "2026-08-02T00:00:00.000Z");

    expect(ledger).toMatchObject({ version: MEMORY_LEDGER_VERSION, migrated_from: { path: "project-state.json" } });
    expect(ledger.records).toHaveLength(1);
    expect(ledger.records[0]).toMatchObject({ scope: "project", approval: { status: "approved" } });
    expect(ledger.proposals[0]).toMatchObject({ status: "accepted", approval: { status: "approved" } });
    expect(ledger.proposals[1]).toMatchObject({ status: "pending", approval: { required: "manual", status: "pending" } });
    expect(ledger.records[0]?.source.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "message", locator: "session-a@message-1", message_id: "message-1" }),
      expect.objectContaining({ kind: "file", locator: "notes.md", path: "notes.md" }),
      expect.objectContaining({ kind: "run", locator: "run-1", run_id: "run-1" }),
      expect.objectContaining({ kind: "citation", locator: "doi:10.1/example" }),
    ]));
  });

  it("lazily writes a canonical ledger and repairs accepted legacy proposals", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-science-memory-ledger-"));
    cleanup.push(cwd);
    await mkdir(join(cwd, ".pi-science"), { recursive: true });
    const legacy = legacyState();
    legacy.items = [];
    await writeFile(join(cwd, ".pi-science", "project-state.json"), JSON.stringify(legacy), "utf8");

    const first = await readMemoryLedger(cwd);
    const second = await readMemoryLedger(cwd);

    expect(first.records).toEqual([expect.objectContaining({ proposal_id: "proposal-1", status: "active" })]);
    expect(second).toEqual(first);
    expect(JSON.parse(await readFile(projectMemoryLedgerPath(cwd), "utf8"))).toMatchObject({ version: 1, records: expect.any(Array), proposals: expect.any(Array) });
  });
});
