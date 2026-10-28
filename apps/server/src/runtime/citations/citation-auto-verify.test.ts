import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CitationAutoVerifyService, finalAnswerForTurn } from "./citation-auto-verify.js";
import type { SessionMessageRecord } from "../node/session-repository.js";
import type { CitationView, VerifyCitationsResult } from "./citation-verify-service.js";

const homes: string[] = [];
const workspaces: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([...homes, ...workspaces].splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** A workspace plus an isolated settings home holding the stored switch. */
async function fixture(settings: Record<string, unknown>): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "pi-citation-auto-home-"));
  homes.push(home);
  vi.stubEnv("PI_SCIENCE_HOME", home);
  await writeFile(join(home, "config.json"), JSON.stringify(settings));
  const cwd = await mkdtemp(join(tmpdir(), "pi-citation-auto-ws-"));
  workspaces.push(cwd);
  await mkdir(join(cwd, ".pi-science"), { recursive: true });
  return cwd;
}

const ON = { citation_auto_verify: true };
const OFF = { citation_auto_verify: false };

function message(text: string, extra: Partial<SessionMessageRecord> = {}): SessionMessageRecord {
  return { id: `msg-${text.slice(0, 8)}`, role: "assistant", content: [{ type: "text", text }], presentationRole: "final", turnId: "turn-1", turnStatus: "completed", ...extra };
}

const view = (id: string, status: CitationView["status"] = "found"): CitationView => ({
  schema: 2, kind: "doi", id, status, title: "A Paper", authors: [], journal: null, year: "2024", abstract: null, oa_url: null,
  retraction: "clear", retraction_note: null, retraction_url: null, checked_providers: ["crossref"], error: null, record_version: null, status_note: null,
  verified_at: new Date().toISOString(), requested_id: id, requested_version: null, version: "not_applicable", bibliographic: "not_compared", bibliographic_note: null, cached: false,
});

const verifyResult = (citations: CitationView[]): VerifyCitationsResult => ({
  text_sha256: "abc", total: citations.length, processed: citations.length, unprocessed: [], citations,
});

function service(messages: SessionMessageRecord[], verify = vi.fn(async (_cwd: string, _input: { text: string }) => verifyResult([view("10.1038/one")]))) {
  return { svc: new CitationAutoVerifyService({ messages: async () => messages }, verify as never), verify };
}

describe("finalAnswerForTurn", () => {
  it("joins the text parts of the turn's final assistant message", () => {
    const messages = [message("", { content: [{ type: "text", text: "First half. " }, { type: "thinking", text: "hidden" }, { type: "text", text: "Second half." }] })];
    expect(finalAnswerForTurn(messages, "turn-1")).toBe("First half. Second half.");
  });

  it("refuses a turn that did not complete normally", () => {
    for (const turnStatus of ["aborted", "failed", "declined"] as const) {
      expect(finalAnswerForTurn([message("Text", { turnStatus })], "turn-1")).toBeNull();
    }
  });

  it("ignores a turn whose only assistant message is intermediate", () => {
    expect(finalAnswerForTurn([message("Working on it", { presentationRole: "intermediate" })], "turn-1")).toBeNull();
    expect(finalAnswerForTurn([message("No role", { presentationRole: undefined })], "turn-1")).toBeNull();
  });

  it("returns null for an empty or missing answer", () => {
    expect(finalAnswerForTurn([message("   ")], "turn-1")).toBeNull();
    expect(finalAnswerForTurn([], "turn-1")).toBeNull();
  });

  it("returns null when the asked turn has no stored messages, even if an earlier turn does", () => {
    const previous = message("The previous turn's answer.", { turnId: "turn-1" });
    expect(finalAnswerForTurn([previous], "turn-2")).toBeNull();
    expect(finalAnswerForTurn([previous], "turn-1")).toBe("The previous turn's answer.");
  });
});

describe("CitationAutoVerifyService", () => {
  it("contacts no provider while the switch is off", async () => {
    const cwd = await fixture(OFF);
    const { svc, verify } = service([message("Cites 10.1038/one here.")]);
    const summary = await svc.run(cwd, "session-1", "turn-1");
    expect(summary).toMatchObject({ ran: false, citations: 0 });
    expect(summary.reason).toContain("off");
    expect(verify).not.toHaveBeenCalled();
  });

  it("verifies the final answer once per turn and answer", async () => {
    const cwd = await fixture(ON);
    const { svc, verify } = service([message("Cites 10.1038/one and 10.1038/two.")]);
    const first = await svc.run(cwd, "session-1", "turn-1");
    expect(first).toMatchObject({ ran: true, citations: 1 });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(cwd, { text: "Cites 10.1038/one and 10.1038/two." });

    // A replayed settle event, a refresh, or a recovered turn must not query again.
    const replay = await svc.run(cwd, "session-1", "turn-1");
    expect(replay).toMatchObject({ ran: false });
    expect(replay.reason).toContain("already checked");
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("checks a regenerated answer again", async () => {
    const cwd = await fixture(ON);
    const { svc, verify } = service([message("Cites 10.1038/one.")]);
    await svc.run(cwd, "session-1", "turn-1");
    const changed = service([message("Rewritten answer citing 10.1038/three.")]);
    const summary = await changed.svc.run(cwd, "session-1", "turn-1");
    expect(summary).toMatchObject({ ran: true });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(changed.verify).toHaveBeenCalledTimes(1);
  });

  it("skips turns that failed or produced no supported identifier", async () => {
    const cwd = await fixture(ON);
    const aborted = service([message("Cites 10.1038/one.", { turnStatus: "aborted" })]);
    expect((await aborted.svc.run(cwd, "session-1", "turn-1")).ran).toBe(false);
    const plain = service([message("No identifiers here.")]);
    expect((await plain.svc.run(cwd, "session-1", "turn-2")).ran).toBe(false);
    expect(aborted.verify).not.toHaveBeenCalled();
    expect(plain.verify).not.toHaveBeenCalled();
  });

  it("keeps a turn retryable when every lookup failed", async () => {
    const cwd = await fixture(ON);
    const failing = vi.fn(async () => verifyResult([view("10.1038/one", "error")]));
    const { svc } = service([message("Cites 10.1038/one.")], failing);
    expect((await svc.run(cwd, "session-1", "turn-1")).ran).toBe(false);
    expect((await svc.run(cwd, "session-1", "turn-1")).reason).not.toContain("already checked");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("verifies nothing when the settled turn has no stored messages", async () => {
    const cwd = await fixture(ON);
    const { svc, verify } = service([message("The previous turn cites 10.1038/one.")]);
    const summary = await svc.run(cwd, "session-1", "turn-2");
    expect(summary).toMatchObject({ ran: false, citations: 0 });
    expect(summary.reason).toContain("no completed final answer");
    expect(verify).not.toHaveBeenCalled();
  });

  it("releases the claim when verification throws so the answer stays retryable", async () => {
    const cwd = await fixture(ON);
    const failing = vi.fn(async () => { throw new Error("citations.jsonl is unwritable"); });
    const { svc } = service([message("Cites 10.1038/one.")], failing as never);
    expect(String(await svc.run(cwd, "session-1", "turn-1").catch((error: unknown) => error))).toContain("citations.jsonl is unwritable");
    expect(String(await svc.run(cwd, "session-1", "turn-1").catch((error: unknown) => error))).toContain("citations.jsonl is unwritable");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("leaves the claim when a regenerated answer replaced it mid-run", async () => {
    const cwd = await fixture(ON);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = () => resolve(); });
    const verify = vi.fn(async (_cwd: string, input: { text: string }) => {
      if (input.text.includes("old")) { await gate; throw new Error("boom"); }
      return verifyResult([view("10.1038/new")]);
    });
    const stale = service([message("Cites 10.1038/old.")], verify as never);
    const inFlight = stale.svc.run(cwd, "session-1", "turn-1").catch((error: unknown) => error);
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1));

    // The answer is regenerated while the first run still holds the old claim.
    const regenerated = service([message("Cites 10.1038/new.")], verify as never);
    expect((await regenerated.svc.run(cwd, "session-1", "turn-1")).ran).toBe(true);
    release();
    expect(String(await inFlight)).toContain("boom");
    // The failed run released only its own claim; the new answer stays checked.
    expect((await regenerated.svc.run(cwd, "session-1", "turn-1")).reason).toContain("already checked");
  });

  it("queues a second settled turn instead of dropping it", async () => {
    const cwd = await fixture(ON);
    const starts: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = () => resolve(); });
    const verify = vi.fn(async (_cwd: string, input: { text: string }) => { starts.push(input.text); await gate; return verifyResult([view("10.1038/one")]); });
    const { svc } = service([message("Cites 10.1038/one."), message("Cites 10.1038/one.", { turnId: "turn-2" })], verify);
    svc.schedule(cwd, "session-1", "turn-1");
    svc.schedule(cwd, "session-1", "turn-2");
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    release();
    await vi.waitFor(() => expect(starts).toHaveLength(2));
  });
});
