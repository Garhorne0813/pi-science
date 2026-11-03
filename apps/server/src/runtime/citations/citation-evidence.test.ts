import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeJsonAtomic } from "../../storage/persistence.js";
import { fullTextSnapshotPath, snapshotIdOf, type FullTextDeps, type FullTextPassage, type FullTextSnapshot } from "./citation-fulltext.js";
import { citationEvidenceService } from "./citation-evidence.js";
import { citationPassagesService } from "./citation-passages.js";

const workspaces: string[] = [];
const KEY = "doi:10.1038/s41586-020-2649-2";
const SESSION = "session-a";
const OTHER_SESSION = "session-b";
/** A fetch that must never be reached: every fixture below is already on disk. */
const NO_FETCH = (() => { throw new Error("network must not be used"); }) as unknown as typeof fetch;
const DEPS: FullTextDeps = { fetch: NO_FETCH, lookup: async () => [{ address: "93.184.216.34", family: 4 }], minimumInterval: { "www.ebi.ac.uk": 0, "arxiv.org": 0 } };

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-science-evidence-home-"));
  workspaces.push(home);
  vi.stubEnv("PI_SCIENCE_HOME", home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-evidence-"));
  workspaces.push(cwd);
  return cwd;
}

const paragraph = (text: string, sectionTitle: string | null, index: number): FullTextPassage => ({ index, section_title: sectionTitle, section_id: sectionTitle ? sectionTitle.toUpperCase().slice(0, 4) : null, page: null, text });

const RESULTS_TEXT = "Attention layers alone reach a better BLEU score than the recurrent baseline on every translation pair we tested.";
const METHODS_TEXT = "We trained each model on eight GPUs for three and a half days and used one shared vocabulary for every configuration.";
const PASSAGES: FullTextPassage[] = [
  paragraph("Recurrent neural networks have been the standard approach to sequence modelling for many years and remain the default choice.", "Introduction", 0),
  paragraph(RESULTS_TEXT, "Results", 1),
  paragraph("We compare against a strong recurrent baseline and report the average of five runs for each configuration.", "Results", 2),
  paragraph(METHODS_TEXT, "Methods", 3),
];

function snapshot(passages: FullTextPassage[], contentSha256: string): FullTextSnapshot {
  const sections = [...new Set(passages.map((passage) => passage.section_id))].map((id) => ({ id, title: passages.find((passage) => passage.section_id === id)?.section_title ?? null }));
  return { kind: "doi", id: "10.1038/s41586-020-2649-2", requested_id: "10.1038/s41586-020-2649-2", requested_version: null, state: "available", note: null, provider: "europepmc", url: "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1/fullTextXML", retrieved_at: new Date().toISOString(), content_sha256: contentSha256, license: null, sections, passages };
}

async function seed(cwd: string, value: FullTextSnapshot): Promise<string> {
  await writeJsonAtomic(fullTextSnapshotPath(cwd, value.kind, value.id, value.requested_version), value);
  return String(snapshotIdOf(value));
}

function arxivSnapshot(version: string, text: string): FullTextSnapshot {
  return {
    kind: "arxiv",
    id: "2401.12345",
    requested_id: `2401.12345v${version}`,
    requested_version: version,
    state: "available",
    note: null,
    provider: "arxiv_html",
    url: `https://arxiv.org/html/2401.12345v${version}`,
    retrieved_at: new Date().toISOString(),
    content_sha256: `sha-v${version}`,
    license: null,
    sections: [{ id: "S1", title: "Results" }],
    passages: [{ index: 0, section_title: "Results", section_id: "S1", page: null, text }],
  };
}

async function read(cwd: string, session = SESSION, source = KEY, extra: Record<string, unknown> = {}) {
  return await citationEvidenceService.readSource(cwd, { session_id: session, source, ...extra }, DEPS);
}

describe("generation-time evidence", () => {
  it("hands the model numbered passages and a snapshot id", async () => {
    const cwd = await makeWorkspace();
    const snapshotId = await seed(cwd, snapshot(PASSAGES, "sha-a"));

    const result = await read(cwd);

    expect(result.state).toBe("available");
    expect(result.snapshot_id).toBe(snapshotId);
    expect(result.total).toBe(4);
    expect(result.passages.map((passage) => passage.passage_id)).toEqual(["p0", "p1", "p2", "p3"]);
    expect(result.passages[1]?.text).toBe(RESULTS_TEXT);
    expect(result.passages[1]?.section_title).toBe("Results");
  });

  it("delivers, and records, the text of the arXiv version each citation names", async () => {
    const cwd = await makeWorkspace();
    const V1_TEXT = "The first version reports that the encoder adds no recurrent state of its own to the model.";
    const V2_TEXT = "The second version reports that the encoder was replaced by a convolutional stem in every experiment.";
    const v1 = arxivSnapshot("1", V1_TEXT);
    const v2 = arxivSnapshot("2", V2_TEXT);
    await writeJsonAtomic(fullTextSnapshotPath(cwd, "arxiv", "2401.12345", "1"), v1);
    await writeJsonAtomic(fullTextSnapshotPath(cwd, "arxiv", "2401.12345", "2"), v2);

    const readV1 = await read(cwd, SESSION, "arxiv:2401.12345v1");
    const readV2 = await read(cwd, SESSION, "arxiv:2401.12345v2");

    expect(readV1.passages.map((passage) => passage.text)).toEqual([V1_TEXT]);
    expect(readV1.snapshot_id).toBe(snapshotIdOf(v1));
    expect(readV2.passages.map((passage) => passage.text)).toEqual([V2_TEXT]);
    expect(readV2.snapshot_id).toBe(snapshotIdOf(v2));
    expect(readV2.snapshot_id).not.toBe(readV1.snapshot_id);

    const recorded = await citationEvidenceService.record(cwd, { session_id: SESSION, selections: [{ source: "arxiv:2401.12345v2", claim: V2_TEXT, snapshot_id: String(readV2.snapshot_id), passage_ids: ["p0"] }] });
    expect(recorded).toMatchObject({ accepted: 1, rejected: 0 });

    const [position] = await citationPassagesService.positions(cwd, { session_id: SESSION, positions: [{ key: "arxiv:2401.12345v2", claim: V2_TEXT }] }, DEPS);
    expect(position?.origin).toBe("generation");
    expect(position?.excerpts.map((excerpt) => excerpt.text)).toEqual([V2_TEXT]);
  });

  it("pages through a source without repeating a passage", async () => {
    const cwd = await makeWorkspace();
    await seed(cwd, snapshot(PASSAGES, "sha-a"));

    const first = await read(cwd, SESSION, KEY, { limit: 2 });
    const second = await read(cwd, SESSION, KEY, { limit: 2, skip: 2 });

    expect(first.passages.map((passage) => passage.passage_id)).toEqual(["p0", "p1"]);
    expect(second.passages.map((passage) => passage.passage_id)).toEqual(["p2", "p3"]);
  });

  it("reads only the passages of the section that was asked for", async () => {
    const cwd = await makeWorkspace();
    await seed(cwd, snapshot(PASSAGES, "sha-a"));

    const result = await read(cwd, SESSION, KEY, { section: "Methods" });

    expect(result.passages.map((passage) => passage.passage_id)).toEqual(["p3"]);
  });

  it("reports a source with no open full text and records no delivery", async () => {
    const cwd = await makeWorkspace();
    await writeJsonAtomic(fullTextSnapshotPath(cwd, "doi", "10.1038/s41586-020-2649-2"), { ...snapshot([], "sha-a"), state: "no_open_fulltext", note: "europepmc: no open-access full text", content_sha256: null });

    const result = await read(cwd);
    const recorded = await citationEvidenceService.lookup(cwd, { session_id: SESSION, key: KEY, claim: RESULTS_TEXT });

    expect(result.state).toBe("no_open_fulltext");
    expect(result.passages).toEqual([]);
    expect(recorded.state).toBe("absent");
  });

  it("answers a recorded citation with the passages the model selected", async () => {
    const cwd = await makeWorkspace();
    const snapshotId = await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd);

    const recorded = await citationEvidenceService.record(cwd, { session_id: SESSION, selections: [{ source: KEY, claim: RESULTS_TEXT, snapshot_id: snapshotId, passage_ids: ["p1"] }] });
    expect(recorded).toMatchObject({ accepted: 1, rejected: 0 });

    const [position] = await citationPassagesService.positions(cwd, { session_id: SESSION, positions: [{ key: KEY, claim: RESULTS_TEXT }] }, DEPS);

    expect(position?.origin).toBe("generation");
    expect(position?.state).toBe("matched");
    expect(position?.snapshot_id).toBe(snapshotId);
    expect(position?.excerpts.map((excerpt) => excerpt.text)).toEqual([RESULTS_TEXT]);
    expect(position?.excerpts[0]?.passage_id).toBe("p1");
    expect(position?.excerpts[0]?.score).toBeNull();
    expect(position?.excerpts[0]?.before).toBe(PASSAGES[0]?.text);
    expect(position?.excerpts[0]?.after).toBe(PASSAGES[2]?.text);
  });

  it("gives two sentences of one paper their own passages", async () => {
    const cwd = await makeWorkspace();
    const snapshotId = await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd);

    await citationEvidenceService.record(cwd, {
      session_id: SESSION,
      selections: [
        { source: KEY, claim: RESULTS_TEXT, snapshot_id: snapshotId, passage_ids: ["p1"] },
        { source: KEY, claim: METHODS_TEXT, snapshot_id: snapshotId, passage_ids: ["p3"] },
      ],
    });

    const positions = await citationPassagesService.positions(cwd, { session_id: SESSION, positions: [{ key: KEY, claim: RESULTS_TEXT }, { key: KEY, claim: METHODS_TEXT }] }, DEPS);

    expect(positions[0]?.excerpts[0]?.text).toBe(RESULTS_TEXT);
    expect(positions[1]?.excerpts[0]?.text).toBe(METHODS_TEXT);
    expect(positions[0]?.excerpts[0]?.text).not.toBe(positions[1]?.excerpts[0]?.text);
  });

  it("rejects a passage the session was never shown", async () => {
    const cwd = await makeWorkspace();
    const snapshotId = await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd, SESSION, KEY, { limit: 1 });

    const recorded = await citationEvidenceService.record(cwd, { session_id: SESSION, selections: [{ source: KEY, claim: RESULTS_TEXT, snapshot_id: snapshotId, passage_ids: ["p2"] }] });

    expect(recorded.results[0]).toMatchObject({ accepted: false, reason: "not_delivered" });
    expect((await citationEvidenceService.lookup(cwd, { session_id: SESSION, key: KEY, claim: RESULTS_TEXT })).state).toBe("absent");
  });

  it("keeps one session's delivery out of another session's evidence", async () => {
    const cwd = await makeWorkspace();
    const snapshotId = await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd, SESSION);

    const recorded = await citationEvidenceService.record(cwd, { session_id: OTHER_SESSION, selections: [{ source: KEY, claim: RESULTS_TEXT, snapshot_id: snapshotId, passage_ids: ["p1"] }] });

    expect(recorded.results[0]).toMatchObject({ accepted: false, reason: "not_delivered" });
  });

  it("keeps one session's selection out of another session's card", async () => {
    const cwd = await makeWorkspace();
    const snapshotId = await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd, SESSION);
    await citationEvidenceService.record(cwd, { session_id: SESSION, selections: [{ source: KEY, claim: RESULTS_TEXT, snapshot_id: snapshotId, passage_ids: ["p1"] }] });

    const [position] = await citationPassagesService.positions(cwd, { session_id: OTHER_SESSION, positions: [{ key: KEY, claim: RESULTS_TEXT }] }, DEPS);

    expect(position?.origin).toBe("located");
  });

  it("rejects a passage the snapshot does not hold", async () => {
    const cwd = await makeWorkspace();
    const snapshotId = await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd);

    const recorded = await citationEvidenceService.record(cwd, { session_id: SESSION, selections: [{ source: KEY, claim: RESULTS_TEXT, snapshot_id: snapshotId, passage_ids: ["p99"] }] });

    expect(recorded.results[0]).toMatchObject({ accepted: false, reason: "unknown_passage" });
  });

  it("rejects a snapshot id no stored read answers", async () => {
    const cwd = await makeWorkspace();
    await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd);

    const recorded = await citationEvidenceService.record(cwd, { session_id: SESSION, selections: [{ source: KEY, claim: RESULTS_TEXT, snapshot_id: "0123456789abcdef01234567", passage_ids: ["p1"] }] });

    expect(recorded.results[0]).toMatchObject({ accepted: false, reason: "unknown_snapshot" });
  });

  it("rejects a source key that is not a DOI or an arXiv id", async () => {
    const cwd = await makeWorkspace();
    const recorded = await citationEvidenceService.record(cwd, { session_id: SESSION, selections: [{ source: "pmid:12345", claim: "A sentence.", snapshot_id: "x", passage_ids: ["p1"] }] });

    expect(recorded.results[0]).toMatchObject({ accepted: false, reason: "bad_source" });
  });

  it("rejects a selection with no claim and one with an over-long claim", async () => {
    const cwd = await makeWorkspace();
    const snapshotId = await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd);

    const recorded = await citationEvidenceService.record(cwd, {
      session_id: SESSION,
      selections: [
        { source: KEY, claim: "   ", snapshot_id: snapshotId, passage_ids: ["p1"] },
        { source: KEY, claim: "x".repeat(4_001), snapshot_id: snapshotId, passage_ids: ["p1"] },
      ],
    });

    expect(recorded.results.map((result) => result.reason)).toEqual(["empty_claim", "empty_claim"]);
  });

  it("reports stale, not wrong text, once the paper is read again", async () => {
    const cwd = await makeWorkspace();
    const first = await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd);
    await citationEvidenceService.record(cwd, { session_id: SESSION, selections: [{ source: KEY, claim: RESULTS_TEXT, snapshot_id: first, passage_ids: ["p1"] }] });

    const rewritten = PASSAGES.map((passage, index) => (index === 1 ? { ...passage, text: "The revised analysis reports a smaller gain than the first submission did." } : passage));
    // No version file was written for the first read, so the recorded bytes are
    // gone: the card must say so rather than quote the new text.
    await writeJsonAtomic(fullTextSnapshotPath(cwd, "doi", "10.1038/s41586-020-2649-2"), snapshot(rewritten, "sha-b"));

    const [position] = await citationPassagesService.positions(cwd, { session_id: SESSION, positions: [{ key: KEY, claim: RESULTS_TEXT }] }, DEPS);

    expect(position?.origin).toBe("generation");
    expect(position?.state).toBe("stale");
    expect(position?.excerpts).toEqual([]);
  });

  it("still answers the recorded text after the paper is read again", async () => {
    const cwd = await makeWorkspace();
    const snapshotId = await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd);
    await citationEvidenceService.record(cwd, { session_id: SESSION, selections: [{ source: KEY, claim: RESULTS_TEXT, snapshot_id: snapshotId, passage_ids: ["p1"] }] });

    const rewritten = PASSAGES.map((passage, index) => (index === 1 ? { ...passage, text: "The revised analysis reports a smaller gain than the first submission did." } : passage));
    const refetched = { ...snapshot(rewritten, "sha-b") };
    await writeJsonAtomic(fullTextSnapshotPath(cwd, "doi", "10.1038/s41586-020-2649-2"), refetched);
    // The earlier read is kept beside the current one, which is what lets the
    // recorded citation keep showing the paragraph it was recorded against.
    const { fullTextVersionPath } = await import("./citation-fulltext.js");
    await writeJsonAtomic(fullTextVersionPath(cwd, "doi", "10.1038/s41586-020-2649-2", snapshotId), snapshot(PASSAGES, "sha-a"));

    const [position] = await citationPassagesService.positions(cwd, { session_id: SESSION, positions: [{ key: KEY, claim: RESULTS_TEXT }] }, DEPS);

    expect(position?.state).toBe("matched");
    expect(position?.excerpts[0]?.text).toBe(RESULTS_TEXT);
    expect(position?.snapshot_id).toBe(snapshotId);
  });
});

describe("recorded claim matching", () => {
  /** The model writes the identifier inline and the reader's body shows a
   *  number where it was, so the two spellings of one sentence have to reach the
   *  same record. A recorded passage that no spelling can find is the defect
   *  this guards: the card then falls back to a search of the finished
   *  sentence and shows whatever that search ranked first. */
  const CLAIM_WITH_DOI = `AlphaFold reached a median backbone RMSD of 0.96 Å in CASP14, doi:10.1038/s41586-020-2649-2`;

  it("finds the record when the body shows a number where the identifier was", async () => {
    const cwd = await makeWorkspace();
    const snapshotId = await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd);
    await citationEvidenceService.record(cwd, { session_id: SESSION, selections: [{ source: KEY, claim: CLAIM_WITH_DOI, snapshot_id: snapshotId, passage_ids: ["p1"] }] });

    const found = await citationEvidenceService.lookup(cwd, { session_id: SESSION, key: KEY, claim: "AlphaFold reached a median backbone RMSD of 0.96 Å in CASP14, [1]" });

    expect(found.state).toBe("recorded");
    if (found.state === "absent") return;
    expect(found.record.match).toBe("normalized");
    expect(found.record.passage_ids).toEqual(["p1"]);
  });

  it("finds the record when the finished sentence is worded a little differently", async () => {
    const cwd = await makeWorkspace();
    const snapshotId = await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd);
    await citationEvidenceService.record(cwd, { session_id: SESSION, selections: [{ source: KEY, claim: CLAIM_WITH_DOI, snapshot_id: snapshotId, passage_ids: ["p1"] }] });

    const found = await citationEvidenceService.lookup(cwd, { session_id: SESSION, key: KEY, claim: "In CASP14, AlphaFold reached a median backbone RMSD of 0.96 Å." });

    expect(found.state).toBe("recorded");
    if (found.state === "absent") return;
    expect(found.record.match).toBe("similar");
    expect(found.record.passage_ids).toEqual(["p1"]);
  });

  it("answers absent for a sentence about something else", async () => {
    const cwd = await makeWorkspace();
    const snapshotId = await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd);
    await citationEvidenceService.record(cwd, { session_id: SESSION, selections: [{ source: KEY, claim: CLAIM_WITH_DOI, snapshot_id: snapshotId, passage_ids: ["p1"] }] });

    const found = await citationEvidenceService.lookup(cwd, { session_id: SESSION, key: KEY, claim: "Photosynthesis in alpine lichens depends on the snow cover of the previous winter." });

    expect(found.state).toBe("absent");
  });

  it("refuses to choose between two equally close recorded sentences", async () => {
    const cwd = await makeWorkspace();
    const snapshotId = await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd);
    await citationEvidenceService.record(cwd, {
      session_id: SESSION,
      selections: [
        { source: KEY, claim: "The model reached its best CASP14 score under the standard protocol.", snapshot_id: snapshotId, passage_ids: ["p1"] },
        { source: KEY, claim: "The model reached its best CASP14 score under the revised protocol.", snapshot_id: snapshotId, passage_ids: ["p2"] },
      ],
    });

    const found = await citationEvidenceService.lookup(cwd, { session_id: SESSION, key: KEY, claim: "The model reached its best CASP14 score under the protocol." });

    expect(found.state).toBe("absent");
  });

  it("matches a selection whose source is spelled with another case", async () => {
    const cwd = await makeWorkspace();
    const snapshotId = await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd, SESSION, "doi:10.1038/S41586-020-2649-2");

    const recorded = await citationEvidenceService.record(cwd, { session_id: SESSION, selections: [{ source: "doi:10.1038/s41586-020-2649-2", claim: RESULTS_TEXT, snapshot_id: snapshotId, passage_ids: ["p1"] }] });

    expect(recorded.results[0]).toMatchObject({ accepted: true, reason: null });
    expect((await citationEvidenceService.lookup(cwd, { session_id: SESSION, key: KEY, claim: RESULTS_TEXT })).state).toBe("recorded");
  });

  it("still answers for a claim the model recorded before a rewrite of the answer", async () => {
    const cwd = await makeWorkspace();
    const snapshotId = await seed(cwd, snapshot(PASSAGES, "sha-a"));
    await read(cwd);
    await citationEvidenceService.record(cwd, { session_id: SESSION, selections: [{ source: KEY, claim: "Attention layers alone reach a better BLEU score than the recurrent baseline on every translation pair we tested.", snapshot_id: snapshotId, passage_ids: ["p1"] }] });

    const [position] = await citationPassagesService.positions(cwd, { session_id: SESSION, positions: [{ key: KEY, claim: "Attention layers alone reach a better BLEU score than the recurrent baseline, [1]" }] }, DEPS);

    expect(position?.origin).toBe("generation");
    expect(position?.excerpts[0]?.text).toBe(RESULTS_TEXT);
    expect(position?.supplementary?.some((excerpt) => excerpt.passage_id === "p1")).toBe(false);
  });
});
