/**
 * Content and safety tests for the builtin scheduled-tasks skill.
 *
 * Validates the real SKILL.md against the server skill catalog (frontmatter
 * schema) and asserts the operational rules docs/定时任务统一详细实现方案.md
 * §13.6 requires: URL-encoded cwd on every call, status-first availability
 * check, the exact literature_digest provider allowlist, the mandatory human
 * approval gate, 202 run polling, revision-conflict and scheduler-unavailable
 * handling, and the hard prohibitions (no SQLite, no legacy JSON, no shell
 * tasks, no auto-approve). Run via `pnpm test:skills`.
 */

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkill, validateDirectory } from "../../apps/server/src/catalog/skill-catalog.js";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const SKILL_MD = resolve(SKILL_DIR, "SKILL.md");
const SKILLS_ROOT = resolve(SKILL_DIR, "..");

const ALLOWED_PROVIDERS = ["pubmed", "genbank", "arxiv", "pubchem", "uniprot"];

describe("scheduled-tasks skill content", () => {
  it("exists with frontmatter that validates against the catalog schema", async () => {
    const validations = await validateDirectory(SKILL_DIR);
    expect(validations).toHaveLength(1);
    expect(validations[0]?.errors).toEqual([]);
    expect(validations[0]?.warnings).toEqual([]);
    expect(validations[0]?.valid).toBe(true);

    const record = await parseSkill(SKILL_MD, "builtin", SKILLS_ROOT);
    expect(record.metadata.name).toBe("scheduled-tasks");
    expect(record.metadata.license).toBeTruthy();
    expect(record.metadata.description.length).toBeGreaterThan(0);
    expect(record.metadata.description.length).toBeLessThanOrEqual(1024);
  });

  it("requires only curl against the local control plane (no direct third-party calls)", async () => {
    const record = await parseSkill(SKILL_MD, "builtin", SKILLS_ROOT);
    const names = record.metadata.requirements.map((r) => r.name);
    expect(names).toContain("curl");
    expect(record.metadata.third_party).toEqual([]);
  });

  it("documents the URL-encoded cwd pattern and forbids unencoded forms", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    // The mandated encoding pattern, and the availability check first.
    expect(body).toContain('--data-urlencode "cwd=$PWD"');
    expect(body).toContain("/api/scheduled-tasks/status");
    expect(body).toMatch(/confirm availability|Step 0/i);

    // Every cwd occurrence must be inside a --data-urlencode argument: neither
    // $(pwd) nor a raw ?cwd=... query string may appear (paths with spaces
    // break both, docs §15.3).
    expect(body).not.toContain("$(");
    const occurrences = body.match(/.{0,40}cwd=\$/g) ?? [];
    expect(occurrences.length).toBeGreaterThan(2);
    for (const occurrence of occurrences) {
      expect(occurrence).toContain("--data-urlencode");
    }
  });

  it("restricts providers to the supported allowlist and never mentions Crossref", async () => {
    const body = await readFile(SKILL_MD, "utf8");
    const lowered = body.toLowerCase();

    for (const provider of ALLOWED_PROVIDERS) {
      expect(lowered).toContain(provider);
    }
    // Crossref is not supported by the scheduled digest pipeline (docs §15.3).
    expect(lowered).not.toContain("crossref");
    // Shell-style executors are rejected by design and must never appear as an
    // accepted request field.
    expect(lowered).toContain("shell");
    expect(lowered).toContain("job_command");
    expect(body).not.toMatch(/job_command"\s*:/);
    expect(body).not.toMatch(/"kind"\s*:\s*"(?!literature_digest)/);
  });

  it("contains a complete create request example with approval follow-up", async () => {
    const body = await readFile(SKILL_MD, "utf8");
    expect(body).toContain('"kind": "literature_digest"');
    expect(body).toContain('"misfire_policy"');
    expect(body).toContain("approval_status");
    expect(body).toContain("expected_revision");
    expect(body).toContain("approval_scope_hash");
    expect(body).toContain("/approve");
    expect(body).toContain('"categories"');
  });

  it("states the mandatory explicit-human approval gate and rejects auto-approval", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    // Explicit-approval semantics must be present (English or Chinese).
    expect(body).toMatch(/explicitly approves|explicit user approval|explicit human/i);
    expect(body).toMatch(/auto[- ]approv|不自动批准/);
    // Task creation must never be read as egress approval.
    expect(body).toMatch(/are NOT approvals of sensitive egress/);
    // Categories and terms must be shown to the user before approve.
    expect(body).toMatch(/categories.*terms|terms.*categories/s);
    expect(body).toContain("Never auto-approve");
  });

  it("handles manual-run 202 with polling until a terminal state", async () => {
    const body = await readFile(SKILL_MD, "utf8");
    expect(body).toContain("202 Accepted");
    expect(body).toMatch(/[Pp]oll/);
    expect(body).toContain("/runs/");
    for (const terminal of ["succeeded", "failed", "cancelled", "interrupted"]) {
      expect(body).toContain(terminal);
    }
  });

  it("documents revision conflicts, active runs, and all scheduler-unavailable codes", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    expect(body).toContain("SCHEDULED_TASK_REVISION_CONFLICT");
    expect(body).toMatch(/Re-GET|re-read|re-list/i);
    expect(body).toMatch(/Never blind-retry/);

    expect(body).toContain("TASK_HAS_ACTIVE_RUN");
    expect(body).toContain("cancel");

    // All three 503 codes mean the durable scheduler is unavailable and the
    // agent must say so instead of falling back.
    expect(body).toContain("SCHEDULED_TASKS_DISABLED");
    expect(body).toContain("SCHEDULED_TASKS_SQLITE_DISABLED");
    expect(body).toContain("SCHEDULED_TASKS_SQLITE_UNAVAILABLE");
    expect(body).toContain("durable scheduler is unavailable");
    expect(body).toContain("Do not simulate");
  });

  it("keeps the hard prohibitions: no SQLite access, no legacy JSON edits, no shell tasks", async () => {
    const body = await readFile(SKILL_MD, "utf8");

    expect(body).toMatch(/Never read or write SQLite files directly/);
    expect(body).toMatch(/Never edit legacy JSON state/);
    expect(body).toMatch(/Never create shell or arbitrary-command tasks/);
    expect(body).toMatch(/Hard prohibitions/);
    // No non-curl execution guidance may leak into the document.
    expect(body).not.toContain("bash -c");
    expect(body).not.toContain("#!/bin/");
  });
});
