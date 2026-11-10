import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendJsonLine,
  readJsonLines,
  workspaceFile,
  writeJsonAtomic,
} from "../../storage/persistence.js";
import {
  fullTextSnapshotPath,
  type FullTextDeps,
  type FullTextPassage,
  type FullTextSnapshot,
} from "./citation-fulltext.js";
import { citationPassagesService } from "./citation-passages.js";

const workspaces: string[] = [];
const FAST: FullTextDeps["minimumInterval"] = {
  "www.ebi.ac.uk": 0,
  "arxiv.org": 0,
  "example.org": 0,
};

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-science-passages-home-"));
  workspaces.push(home);
  vi.stubEnv("PI_SCIENCE_HOME", home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-passages-"));
  workspaces.push(cwd);
  return cwd;
}

const KEY = "doi:10.1038/s41586-020-2649-2";

const paragraph = (
  text: string,
  sectionTitle: string | null,
  sectionId: string | null,
  index: number,
): FullTextPassage => ({
  index,
  section_title: sectionTitle,
  section_id: sectionId,
  page: null,
  text,
});

const PASSAGES: FullTextPassage[] = [
  paragraph(
    "Recurrent neural networks have been the standard approach to sequence modelling for many years, and they remain the default choice for translation systems.",
    "Introduction",
    "S1",
    0,
  ),
  paragraph(
    "We propose a transformer architecture built entirely from attention layers, and it removes recurrence from the model completely.",
    "Introduction",
    "S1",
    1,
  ),
  paragraph(
    "The transformer reaches a better BLEU score on the translation benchmark while training in a fraction of the time of the recurrent baseline.",
    "Results",
    "S2",
    2,
  ),
  paragraph(
    "We trained each model on eight GPUs for three and a half days and used the same vocabulary for every configuration we report.",
    "Methods",
    "S3",
    3,
  ),
];

function snapshot(passages: FullTextPassage[], contentSha256: string): FullTextSnapshot {
  const sections = [...new Set(passages.map((passage) => passage.section_id))].map((id) => ({
    id,
    title: passages.find((passage) => passage.section_id === id)?.section_title ?? null,
  }));
  return {
    kind: "doi",
    id: "10.1038/s41586-020-2649-2",
    requested_id: "10.1038/s41586-020-2649-2",
    requested_version: null,
    state: "available",
    note: null,
    provider: "europepmc",
    url: "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC1/fullTextXML",
    retrieved_at: new Date().toISOString(),
    content_sha256: contentSha256,
    license: null,
    sections,
    passages,
  };
}

async function seedSnapshot(cwd: string, value: FullTextSnapshot): Promise<void> {
  await writeJsonAtomic(fullTextSnapshotPath(cwd, value.kind, value.id), value);
}

async function cacheRows(cwd: string): Promise<Array<Record<string, unknown>>> {
  return readJsonLines<Record<string, unknown>>(workspaceFile(cwd, "citations-passages.jsonl"));
}

describe("citation passages", () => {
  it("finds the passage an English claim talks about", async () => {
    const cwd = await makeWorkspace();
    await seedSnapshot(cwd, snapshot(PASSAGES, "sha-a"));

    const [result] = await citationPassagesService.positions(cwd, {
      positions: [
        {
          key: KEY,
          claim:
            "The transformer reaches a better BLEU score than the recurrent baseline on translation.",
        },
      ],
    });

    expect(result?.state).toBe("matched");
    expect(result?.excerpts[0]?.text).toBe(PASSAGES[2]?.text);
    expect(result?.excerpts[0]?.section_title).toBe("Results");
    expect(result?.excerpts[0]?.section_id).toBe("S2");
    expect(result?.excerpts[0]?.before).toBe(PASSAGES[1]?.text);
    expect(result?.excerpts[0]?.after).toBe(PASSAGES[3]?.text);
    expect(result?.excerpts[0]?.score).toBeGreaterThan(0);
    expect(result?.snapshot_sha256).toBe("sha-a");
  });

  it("returns no_match for a claim the source does not discuss", async () => {
    const cwd = await makeWorkspace();
    await seedSnapshot(cwd, snapshot(PASSAGES, "sha-a"));

    const [result] = await citationPassagesService.positions(cwd, {
      positions: [
        {
          key: KEY,
          claim:
            "Photosynthesis in alpine lichens depends on the snow cover of the previous winter.",
        },
      ],
    });

    expect(result?.state).toBe("no_match");
    expect(result?.excerpts).toEqual([]);
  });

  it("quotes only verbatim snapshot text", async () => {
    const cwd = await makeWorkspace();
    await seedSnapshot(cwd, snapshot(PASSAGES, "sha-a"));

    const [result] = await citationPassagesService.positions(cwd, {
      positions: [
        {
          key: KEY,
          claim:
            "The transformer reaches a better BLEU score than the recurrent baseline on translation.",
        },
      ],
    });

    expect(result?.excerpts.length).toBeGreaterThan(0);
    for (const excerpt of result?.excerpts ?? []) {
      expect(PASSAGES.some((passage) => passage.text.includes(excerpt.text))).toBe(true);
      expect(excerpt.before.length).toBeLessThanOrEqual(200);
      expect(excerpt.after.length).toBeLessThanOrEqual(200);
      if (excerpt.before)
        expect(PASSAGES.some((passage) => passage.text.includes(excerpt.before))).toBe(true);
      if (excerpt.after)
        expect(PASSAGES.some((passage) => passage.text.includes(excerpt.after))).toBe(true);
    }
  });

  it("answers two claims about one source from different passages", async () => {
    const cwd = await makeWorkspace();
    await seedSnapshot(cwd, snapshot(PASSAGES, "sha-a"));

    const [results] = [
      await citationPassagesService.positions(cwd, {
        positions: [
          { key: KEY, claim: "Training ran on eight GPUs for three and a half days." },
          { key: KEY, claim: "Attention layers replace recurrence in the proposed transformer." },
        ],
      }),
    ];

    expect(results?.[0]?.excerpts[0]?.text).toBe(PASSAGES[3]?.text);
    expect(results?.[1]?.excerpts[0]?.text).toBe(PASSAGES[1]?.text);
    expect(results?.[0]?.excerpts[0]?.text).not.toBe(results?.[1]?.excerpts[0]?.text);
  });

  it("re-finds a position when the stored full text changed", async () => {
    const cwd = await makeWorkspace();
    const claim =
      "The transformer reaches a better BLEU score than the recurrent baseline on translation.";
    await seedSnapshot(cwd, snapshot(PASSAGES, "sha-a"));
    const [before] = await citationPassagesService.positions(cwd, {
      positions: [{ key: KEY, claim }],
    });
    expect(before?.excerpts[0]?.text).toBe(PASSAGES[2]?.text);

    const rewritten = PASSAGES.map((passage, index) =>
      index === 2
        ? {
            ...passage,
            text: "The transformer reports a better BLEU score on the translation benchmark than the recurrent baseline did.",
          }
        : passage,
    );
    await seedSnapshot(cwd, snapshot(rewritten, "sha-b"));
    const [after] = await citationPassagesService.positions(
      cwd,
      { positions: [{ key: KEY, claim }] },
      { fetch: vi.fn() as unknown as typeof fetch },
    );

    expect(after?.snapshot_sha256).toBe("sha-b");
    expect(after?.excerpts[0]?.text).toBe(rewritten[2]?.text);
    const rows = await cacheRows(cwd);
    expect(rows.map((row) => row.snapshot_sha256)).toEqual(["sha-a", "sha-b"]);
  });

  it("answers unfetched without touching the network when fetch is false", async () => {
    const cwd = await makeWorkspace();
    const fetchFn = vi.fn();

    const [result] = await citationPassagesService.positions(
      cwd,
      { positions: [{ key: KEY, claim: "Any claim at all." }], fetch: false },
      { fetch: fetchFn as unknown as typeof fetch, minimumInterval: FAST },
    );

    expect(result?.state).toBe("unfetched");
    expect(result?.note).toBe("full text not fetched yet");
    expect(result?.excerpts).toEqual([]);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reads the source when fetching is allowed", async () => {
    const cwd = await makeWorkspace();
    // HTTP fixtures must also inject DNS so outbound validation stays offline.
    const lookup = vi.fn(async (_hostname: string) => [{ address: "93.184.216.34", family: 4 }]);
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const body = Buffer.from(
        url.host === "www.ebi.ac.uk"
          ? JSON.stringify({ hitCount: 0, resultList: { result: [] } })
          : "not found",
        "utf8",
      );
      const status = url.host === "www.ebi.ac.uk" ? 200 : 404;
      return {
        ok: status < 400,
        status,
        headers: new Headers(),
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      } as unknown as Response;
    });

    const [result] = await citationPassagesService.positions(
      cwd,
      { positions: [{ key: "arxiv:2401.12345", claim: "A claim about attention." }] },
      { fetch: fetchFn as unknown as typeof fetch, lookup, minimumInterval: FAST },
    );

    expect(result?.state).toBe("no_open_fulltext");
    expect(result?.note).toContain("europepmc");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(lookup).toHaveBeenCalledWith("www.ebi.ac.uk");
    expect(lookup).toHaveBeenCalledWith("arxiv.org");
  });
});

describe("citation passage ranking", () => {
  /** The reported case: one paper, one numbered claim, and a passage of a
   *  section that cannot be the sentence's evidence sharing almost every word
   *  with it. Lexical overlap alone puts the supplement in the card. */
  const BOILERPLATE: FullTextPassage[] = [
    paragraph(
      "In CASP14 the AlphaFold structures reached a median backbone RMSD95 of 0.96 Å, the best result reported for that assessment.",
      "Main",
      "Sec1",
      0,
    ),
    paragraph(
      "For the CASP14 assessment the AlphaFold structures were compared with the best result reported, and each structure median backbone RMSD95 of the assessment was reported in the assessment table of the AlphaFold structures.",
      "Supplementary information",
      "Sec2",
      1,
    ),
    paragraph(
      "We thank the CASP14 assessors for the evaluation targets and the referees for their comments on the AlphaFold structures and on this work.",
      "Acknowledgements",
      "Sec3",
      2,
    ),
  ];
  const BOILERPLATE_CLAIM =
    "The AlphaFold structures in the CASP14 assessment reached the best median backbone RMSD95 reported for a structure in that assessment.";

  it("leaves supplementary material and acknowledgements out of the candidate pool", async () => {
    const cwd = await makeWorkspace();
    await seedSnapshot(cwd, snapshot(BOILERPLATE, "sha-a"));

    const [result] = await citationPassagesService.positions(cwd, {
      positions: [{ key: KEY, claim: BOILERPLATE_CLAIM }],
    });

    expect(result?.state).toBe("matched");
    expect(result?.excerpts.map((excerpt) => excerpt.section_title)).toEqual(["Main"]);
    expect(result?.excerpts[0]?.text).toBe(BOILERPLATE[0]?.text);
  });

  /** The reported case again: the passage that repeats the claim's words but
   *  reports none of its numbers, against the passage that reports them in one
   *  short sentence. */
  const NUMERIC: FullTextPassage[] = [
    paragraph(
      "The CASP14 structures reached 0.96 Å and the next best method 2.8 Å.",
      "Discussion",
      "S2",
      0,
    ),
    paragraph(
      "Across the CASP14 targets the median backbone RMSD of the structures and the next best method were compared for every target of the assessment.",
      "Results",
      "S1",
      1,
    ),
  ];
  const NUMERIC_CLAIM =
    "Across the CASP14 targets, the structures reached a median backbone RMSD of 0.96 Å and the next best method reached 2.8 Å.";

  it("does not offer a passage that reports none of the numbers the claim quotes", async () => {
    const cwd = await makeWorkspace();
    await seedSnapshot(cwd, snapshot(NUMERIC, "sha-b"));

    const [result] = await citationPassagesService.positions(cwd, {
      positions: [{ key: KEY, claim: NUMERIC_CLAIM }],
    });

    expect(result?.excerpts.map((excerpt) => excerpt.passage_id)).toEqual(["p0"]);
    expect(result?.excerpts[0]?.text).toBe(NUMERIC[0]?.text);
  });

  it("shows at most one paragraph per section", async () => {
    const cwd = await makeWorkspace();
    const repeated: FullTextPassage[] = [
      paragraph(
        "Attention layers alone reach a better BLEU score on the translation benchmark than the recurrent baseline we compared against.",
        "Results",
        "S1",
        0,
      ),
      paragraph(
        "The attention model reaches a better BLEU score on the translation benchmark than the recurrent baseline on every language pair.",
        "Results",
        "S1",
        1,
      ),
      paragraph(
        "Our discussion returns to the better BLEU score on translation that the attention model reached against the recurrent baseline.",
        "Discussion",
        "S2",
        2,
      ),
    ];
    await seedSnapshot(cwd, snapshot(repeated, "sha-c"));

    const [result] = await citationPassagesService.positions(cwd, {
      positions: [
        {
          key: KEY,
          claim:
            "Attention layers reach a better BLEU score than the recurrent baseline on the translation benchmark.",
        },
      ],
    });

    // Two paragraphs of one section both match this claim; three candidates from
    // one section would be the same argument quoted three times.
    const ids = (result?.excerpts ?? []).map((excerpt) => excerpt.passage_id);
    const sections = (result?.excerpts ?? []).map((excerpt) => excerpt.section_id);
    expect(ids[0]).toBe("p0");
    expect(ids).not.toContain("p1");
    expect(new Set(sections).size).toBe(sections.length);
  });

  it("re-finds a position whose cached answer came from an older ranking", async () => {
    const cwd = await makeWorkspace();
    await seedSnapshot(cwd, snapshot(BOILERPLATE, "sha-a"));
    const claim = BOILERPLATE_CLAIM;
    // What the previous ranker stored for this exact claim and snapshot: the
    // supplementary paragraph, replayed forever because the cache key has not
    // changed.
    await appendJsonLine(workspaceFile(cwd, "citations-passages.jsonl"), {
      key: KEY,
      claim_sha256: createHash("sha256").update(claim).digest("hex"),
      state: "matched",
      note: null,
      snapshot_sha256: "sha-a",
      snapshot_id: "sha-a-old",
      origin: "located",
      ranker: 1,
      excerpts: [
        {
          text: BOILERPLATE[1]?.text,
          before: "",
          after: "",
          section_title: "Supplementary information",
          section_id: "Sec2",
          page: null,
          score: 9,
          passage_id: "p1",
        },
      ],
    });

    const [result] = await citationPassagesService.positions(cwd, {
      positions: [{ key: KEY, claim }],
    });

    expect(result?.excerpts[0]?.text).toBe(BOILERPLATE[0]?.text);
    expect(result?.excerpts[0]?.section_title).toBe("Main");
    const rows = await cacheRows(cwd);
    expect(rows.map((row) => row.ranker)).toContain(2);
  });
});
