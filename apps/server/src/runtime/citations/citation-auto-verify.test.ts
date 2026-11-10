import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CitationAutoVerifyService,
  citationAutoVerifyEnabled,
  finalAnswerForTurn,
  MAX_VERIFY_ROUNDS,
} from "./citation-auto-verify.js";
import type { SessionMessageRecord } from "../node/session-repository.js";
import {
  citationVerifyService,
  MAX_CITATIONS_PER_CALL,
  type CitationDeps,
  type CitationRef,
  type CitationView,
  type VerifyCitationsResult,
} from "./citation-verify-service.js";

const homes: string[] = [];
const workspaces: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    [...homes, ...workspaces].splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
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
const FAST: CitationDeps["minimumInterval"] = {
  "api.crossref.org": 0,
  "api.unpaywall.org": 0,
  "export.arxiv.org": 0,
  "doi.org": 0,
};

/** A stored message as a real session writes it: no `presentationRole`, because
 *  the runtime only started marking it after these sessions were recorded. */
function message(text: string, extra: Partial<SessionMessageRecord> = {}): SessionMessageRecord {
  return {
    id: `msg-${text.slice(0, 8)}`,
    role: "assistant",
    content: [{ type: "text", text }],
    turnId: "turn-1",
    turnStatus: "completed",
    ...extra,
  };
}

function toolCall(): SessionMessageRecord {
  return message("", { content: [{ type: "toolCall", name: "paper_search" }] });
}

const view = (id: string, status: CitationView["status"] = "found"): CitationView => ({
  schema: 2,
  kind: "doi",
  id,
  status,
  title: "A Paper",
  authors: [],
  journal: null,
  year: "2024",
  volume: null,
  issue: null,
  pages: null,
  abstract: null,
  oa_url: null,
  retraction: "clear",
  retraction_note: null,
  retraction_url: null,
  checked_providers: ["crossref"],
  error: null,
  record_version: null,
  status_note: null,
  verified_at: new Date().toISOString(),
  requested_id: id,
  requested_version: null,
  version: "not_applicable",
  bibliographic: "not_compared",
  bibliographic_note: null,
  cached: false,
});

const verifyResult = (citations: CitationView[]): VerifyCitationsResult => ({
  text_sha256: "abc",
  total: citations.length,
  processed: citations.length,
  unprocessed: [],
  citations,
});

function service(
  messages: SessionMessageRecord[],
  verify = vi.fn(async (_cwd: string, _input: { text: string }) =>
    verifyResult([view("10.1038/one")]),
  ),
) {
  return {
    svc: new CitationAutoVerifyService({ messages: async () => messages }, verify as never),
    verify,
  };
}

const crossrefOk = (message: Record<string, unknown>) =>
  ({ ok: true, status: 200, json: async () => ({ status: "ok", message }) }) as unknown as Response;
const PAPER = { title: ["Batch Paper"], author: [], issued: { "date-parts": [[2020]] } };

/** The real verify service behind a stub provider, so the batching and the
 *  snapshot cache are exercised rather than stood in for. */
function realService(messages: SessionMessageRecord[], fetchMock: typeof fetch) {
  const calls: Array<{ text: string; ids?: CitationRef[] }> = [];
  const verify = (cwd: string, input: { text: string; ids?: CitationRef[] }) => {
    calls.push(input);
    return citationVerifyService.verify(cwd, input, { fetch: fetchMock, minimumInterval: FAST });
  };
  return {
    svc: new CitationAutoVerifyService({ messages: async () => messages }, verify as never),
    calls,
  };
}

describe("finalAnswerForTurn", () => {
  it("joins the text parts of the turn's last assistant message in order", () => {
    const messages = [
      message("", {
        content: [
          { type: "text", text: "First half. " },
          { type: "thinking", text: "hidden" },
          { type: "text", text: "Second half." },
        ],
      }),
    ];
    expect(finalAnswerForTurn(messages, "turn-1")).toBe("First half. Second half.");
  });

  it("prefers the last explicitly final message over the intermediate commentary before it", () => {
    const messages = [
      message("Let me look that up.", { presentationRole: "intermediate" }),
      message("Found three sources.", { presentationRole: "intermediate" }),
      message("The answer cites 10.1038/one.", { presentationRole: "final" }),
    ];
    expect(finalAnswerForTurn(messages, "turn-1")).toBe("The answer cites 10.1038/one.");
    // A final marker stays the answer even when commentary follows it.
    const trailing = [
      ...messages,
      message("Note added afterwards.", { presentationRole: "intermediate" }),
    ];
    expect(finalAnswerForTurn(trailing, "turn-1")).toBe("The answer cites 10.1038/one.");
  });

  it("takes the last of several final messages", () => {
    const messages = [
      message("Draft answer.", { presentationRole: "final" }),
      message("Rewritten answer.", { presentationRole: "final" }),
    ];
    expect(finalAnswerForTurn(messages, "turn-1")).toBe("Rewritten answer.");
  });

  it("returns null when the turn ended on a tool call instead of an answer", () => {
    const messages = [message("Working on it.", { presentationRole: "intermediate" }), toolCall()];
    expect(finalAnswerForTurn(messages, "turn-1")).toBeNull();
    expect(finalAnswerForTurn([toolCall()], "turn-1")).toBeNull();
  });

  it("returns null for an empty answer instead of falling back to an earlier message", () => {
    expect(finalAnswerForTurn([message("   ")], "turn-1")).toBeNull();
    expect(finalAnswerForTurn([message("")], "turn-1")).toBeNull();
    expect(
      finalAnswerForTurn(
        [message("An earlier answer."), message("  ", { presentationRole: "final" })],
        "turn-1",
      ),
    ).toBeNull();
    expect(finalAnswerForTurn([], "turn-1")).toBeNull();
  });

  it("returns null when the last message is marked intermediate", () => {
    expect(
      finalAnswerForTurn(
        [message("Still working.", { presentationRole: "intermediate" })],
        "turn-1",
      ),
    ).toBeNull();
    // The marker on the last message decides; the earlier text is not the answer.
    expect(
      finalAnswerForTurn(
        [
          message("An earlier answer."),
          message("Still working.", { presentationRole: "intermediate" }),
        ],
        "turn-1",
      ),
    ).toBeNull();
  });

  it("refuses a turn that did not complete normally", () => {
    for (const turnStatus of ["aborted", "failed", "declined"] as const) {
      expect(finalAnswerForTurn([message("Text", { turnStatus })], "turn-1")).toBeNull();
    }
  });

  it("returns null when the turn holds no assistant message", () => {
    expect(
      finalAnswerForTurn([message("Cites 10.1038/one.", { role: "user" })], "turn-1"),
    ).toBeNull();
  });

  it("never reads another turn's answer", () => {
    const previous = message("The previous turn's answer cites 10.1038/old.", { turnId: "turn-1" });
    expect(finalAnswerForTurn([previous], "turn-2")).toBeNull();
    expect(finalAnswerForTurn([previous], "turn-1")).toBe(
      "The previous turn's answer cites 10.1038/old.",
    );
    // The asked turn answers from its own last message, never from the older turn.
    const asked = message("This turn cites 10.1038/new.", { turnId: "turn-2" });
    expect(finalAnswerForTurn([previous, asked], "turn-2")).toBe("This turn cites 10.1038/new.");
  });
});

describe("citationAutoVerifyEnabled", () => {
  it("is on when the user never stored a choice", async () => {
    await fixture({});
    expect(await citationAutoVerifyEnabled()).toBe(true);
  });

  it("honours a stored false forever", async () => {
    await fixture(OFF);
    expect(await citationAutoVerifyEnabled()).toBe(false);
  });

  it("reads a stored true as on", async () => {
    await fixture(ON);
    expect(await citationAutoVerifyEnabled()).toBe(true);
  });
});

describe("CitationAutoVerifyService", () => {
  it("verifies a settled turn by default, before the user chose anything", async () => {
    const cwd = await fixture({});
    const { svc, verify } = service([message("Cites 10.1038/one here.")]);
    expect(await svc.run(cwd, "session-1", "turn-1")).toMatchObject({ ran: true, citations: 1 });
    expect(verify).toHaveBeenCalledOnce();
    expect((await svc.run(cwd, "session-1", "turn-1")).reason).toContain("already checked");
    expect(verify).toHaveBeenCalledOnce();
  });

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

  it("checks every cited source across rounds instead of stopping at one batch", async () => {
    const cwd = await fixture(ON);
    const text = `Cites ${Array.from({ length: MAX_CITATIONS_PER_CALL + 2 }, (_, index) => `10.1038/paper-${index}`).join(", ")}.`;
    const fetchMock = vi.fn(async () => crossrefOk(PAPER)) as unknown as typeof fetch;
    const { svc, calls } = realService([message(text)], fetchMock);
    const summary = await svc.run(cwd, "session-1", "turn-1");
    expect(summary).toMatchObject({ ran: true, citations: MAX_CITATIONS_PER_CALL + 2 });
    expect(summary.reason).toBe(
      `Checked ${MAX_CITATIONS_PER_CALL + 2} of ${MAX_CITATIONS_PER_CALL + 2} citations`,
    );
    expect(fetchMock).toHaveBeenCalledTimes(MAX_CITATIONS_PER_CALL + 2);
    // The second round names the sources left over instead of re-scanning the answer.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.ids).toBeUndefined();
    expect(calls[1]!.ids!.map((ref) => ref.id)).toEqual(["10.1038/paper-30", "10.1038/paper-31"]);
    // A replayed settle after full success does no provider work.
    expect((await svc.run(cwd, "session-1", "turn-1")).reason).toContain("already checked");
    expect(fetchMock).toHaveBeenCalledTimes(MAX_CITATIONS_PER_CALL + 2);
  });

  it("keeps a partly failed turn retryable and re-asks only the failed source", async () => {
    const cwd = await fixture(ON);
    let limited = true;
    const queries: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = decodeURIComponent(new URL(String(input)).pathname);
      queries.push(path);
      if (limited && path.endsWith("10.1038/limited"))
        return { ok: false, status: 429, json: async () => ({}) } as unknown as Response;
      return crossrefOk(PAPER);
    }) as unknown as typeof fetch;
    const { svc } = realService([message("Cites 10.1038/known and 10.1038/limited.")], fetchMock);
    const queried = (id: string) => queries.filter((path) => path.endsWith(id)).length;

    const partial = await svc.run(cwd, "session-1", "turn-1");
    expect(partial).toMatchObject({ ran: true, citations: 1 });
    expect(partial.reason).toContain("Checked 1 of 2 citations");
    expect(partial.reason).toContain("1 lookup failed");
    expect(partial.reason).toContain("10.1038/limited");

    // The source that keeps failing is asked again; the one that answered is not.
    const again = await svc.run(cwd, "session-1", "turn-1");
    expect(again.reason).not.toContain("already checked");
    expect(again.reason).toContain("10.1038/limited");
    expect(queried("10.1038/known")).toBe(1);
    expect(queried("10.1038/limited")).toBe(2);

    limited = false;
    expect((await svc.run(cwd, "session-1", "turn-1")).reason).toBe("Checked 2 of 2 citations");
    expect(queried("10.1038/known")).toBe(1);
    expect(queried("10.1038/limited")).toBe(3);
    expect((await svc.run(cwd, "session-1", "turn-1")).reason).toContain("already checked");
    expect(queries).toHaveLength(4);
  });

  it("keeps claims and results apart for two sessions in one workspace", async () => {
    const cwd = await fixture(ON);
    const bySession: Record<string, SessionMessageRecord[]> = {
      "session-1": [message("Session one cites 10.1038/alpha.")],
      "session-2": [message("Session two cites 10.1038/beta.")],
    };
    const queries: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      queries.push(decodeURIComponent(new URL(String(input)).pathname));
      return crossrefOk(PAPER);
    }) as unknown as typeof fetch;
    const verify = (cwdArg: string, input: { text: string; ids?: CitationRef[] }) =>
      citationVerifyService.verify(cwdArg, input, { fetch: fetchMock, minimumInterval: FAST });
    const svc = new CitationAutoVerifyService(
      { messages: async (_cwd, sessionId) => bySession[sessionId] ?? [] },
      verify as never,
    );

    expect((await svc.run(cwd, "session-1", "turn-1")).reason).toBe("Checked 1 of 1 citations");
    expect((await svc.run(cwd, "session-2", "turn-1")).reason).toBe("Checked 1 of 1 citations");
    expect(queries.filter((path) => path.endsWith("10.1038/alpha"))).toHaveLength(1);
    expect(queries.filter((path) => path.endsWith("10.1038/beta"))).toHaveLength(1);
    // Each session holds its own claim, so neither replay is answered from the other.
    expect((await svc.run(cwd, "session-1", "turn-1")).reason).toContain("already checked");
    expect((await svc.run(cwd, "session-2", "turn-1")).reason).toContain("already checked");
    expect(queries).toHaveLength(2);
  });

  it("reports the sources left unchecked when the round bound is hit", async () => {
    const cwd = await fixture(ON);
    const total = MAX_CITATIONS_PER_CALL * (MAX_VERIFY_ROUNDS + 2);
    const text = Array.from({ length: total }, (_, index) => `10.1038/p${index}`).join(" ");
    const refs: CitationRef[] = Array.from({ length: total }, (_, index) => ({
      kind: "doi",
      id: `10.1038/p${index}`,
      requested_id: `10.1038/p${index}`,
      requested_version: null,
    }));
    let offset = 0;
    const verify = vi.fn(async (_cwd: string, _input: { text: string; ids?: CitationRef[] }) => {
      const batch = refs.slice(offset, offset + MAX_CITATIONS_PER_CALL);
      offset += batch.length;
      return {
        text_sha256: "abc",
        total: refs.length,
        processed: batch.length,
        unprocessed: refs.slice(offset),
        citations: batch.map((ref) => view(ref.id)),
      };
    });
    const svc = new CitationAutoVerifyService(
      { messages: async () => [message(text)] },
      verify as never,
    );

    const summary = await svc.run(cwd, "session-1", "turn-1");
    const bounded = MAX_CITATIONS_PER_CALL * MAX_VERIFY_ROUNDS;
    expect(verify).toHaveBeenCalledTimes(MAX_VERIFY_ROUNDS);
    expect(summary.citations).toBe(bounded);
    expect(summary.reason).toContain(`Checked ${bounded} of ${total} citations`);
    expect(summary.reason).toContain(
      `${total - bounded} left unchecked after ${MAX_VERIFY_ROUNDS} rounds`,
    );
    expect(verify.mock.calls[1]![1].ids![0]!.id).toBe("10.1038/p30");
    // The bound is final for this answer: a replay does not restart the work.
    expect((await svc.run(cwd, "session-1", "turn-1")).reason).toContain("already checked");
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
    const failing = vi.fn(async () => {
      throw new Error("citations.jsonl is unwritable");
    });
    const { svc } = service([message("Cites 10.1038/one.")], failing as never);
    expect(
      String(await svc.run(cwd, "session-1", "turn-1").catch((error: unknown) => error)),
    ).toContain("citations.jsonl is unwritable");
    expect(
      String(await svc.run(cwd, "session-1", "turn-1").catch((error: unknown) => error)),
    ).toContain("citations.jsonl is unwritable");
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("leaves the claim when a regenerated answer replaced it mid-run", async () => {
    const cwd = await fixture(ON);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const verify = vi.fn(async (_cwd: string, input: { text: string }) => {
      if (input.text.includes("old")) {
        await gate;
        throw new Error("boom");
      }
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
    expect((await regenerated.svc.run(cwd, "session-1", "turn-1")).reason).toContain(
      "already checked",
    );
  });

  it("queues a second settled turn instead of dropping it", async () => {
    const cwd = await fixture(ON);
    const starts: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    const verify = vi.fn(async (_cwd: string, input: { text: string }) => {
      starts.push(input.text);
      await gate;
      return verifyResult([view("10.1038/one")]);
    });
    const { svc } = service(
      [message("Cites 10.1038/one."), message("Cites 10.1038/one.", { turnId: "turn-2" })],
      verify,
    );
    svc.schedule(cwd, "session-1", "turn-1");
    svc.schedule(cwd, "session-1", "turn-2");
    await vi.waitFor(() => expect(starts).toHaveLength(1));
    release();
    await vi.waitFor(() => expect(starts).toHaveLength(2));
  });
});
