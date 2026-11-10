import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendJsonLine, workspaceFile, writeJsonAtomic } from "../../storage/persistence.js";
import {
  fullTextSnapshot,
  fullTextSnapshotPath,
  fetchFullTextSnapshot,
  snapshotIdOf,
  type FullTextDeps,
  type FullTextRef,
  type FullTextSnapshot,
} from "./citation-fulltext.js";

const workspaces: string[] = [];
/** Every fixture request is local, so no domain needs a real throttle wait. */
const FAST: FullTextDeps["minimumInterval"] = {
  "www.ebi.ac.uk": 0,
  "arxiv.org": 0,
  "example.org": 0,
};
/** The outbound policy resolves a hostname before any request leaves, so the
 *  fixtures answer with a public address instead of asking a DNS server. */
const PUBLIC_DNS: FullTextDeps["lookup"] = async () => [{ address: "93.184.216.34", family: 4 }];

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), "pi-science-fulltext-home-"));
  workspaces.push(home);
  vi.stubEnv("PI_SCIENCE_HOME", home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function makeWorkspace(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-science-fulltext-"));
  workspaces.push(cwd);
  return cwd;
}

function response(body: string | Buffer, status = 200): Response {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  return {
    ok: status < 400,
    status,
    headers: new Headers(),
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    text: async () => bytes.toString("utf8"),
  } as unknown as Response;
}

function fakeFetch(handler: (url: URL) => Response | undefined) {
  return vi.fn(async (input: string | URL | Request) => {
    const answered = handler(new URL(String(input)));
    if (answered) return answered;
    throw new Error(`unexpected request: ${String(input)}`);
  });
}

const DOI = "10.1038/s41586-020-2649-2";
const doiRef: FullTextRef = { kind: "doi", id: DOI, requested_id: DOI, requested_version: null };
const arxivRef = (version: string | null): FullTextRef => ({
  kind: "arxiv",
  id: "2401.12345",
  requested_id: version ? `2401.12345v${version}` : "2401.12345",
  requested_version: version,
});

const epmcSearch = (doi: string, pmcid: string): string =>
  JSON.stringify({
    version: "6.9",
    hitCount: 1,
    resultList: { result: [{ id: "1", source: "MED", doi, pmcid }] },
  });
const epmcMiss = JSON.stringify({ version: "6.9", hitCount: 0, resultList: { result: [] } });

const epmcXml = `<?xml version="1.0" encoding="UTF-8"?>
<article article-type="review-article">
  <front><article-meta><title-group><article-title>Array programming with NumPy</article-title></title-group>
    <permissions><license xlink:href="https://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution 4.0</license></permissions>
  </article-meta></front>
  <body>
    <p>The introduction paragraph says what the article is about in a few hundred plain words.</p>
    <sec id="Sec1"><title>Results</title>
      <p>We find that the array programming model gives scientists a compact notation for numeric work.</p>
      <p>Measurement of the runtime shows that vectorised kernels run much faster than Python loops.</p>
    </sec>
    <sec id="Sec2"><title>Methods</title>
      <p>All experiments ran on a single workstation with a recent Python interpreter and NumPy release.</p>
    </sec>
  </body>
</article>`;

const arxivHtml = `<!DOCTYPE html><html><head><title>Attention Is All You Need</title></head><body>
<article class="ltx_document">
<section id="S1" class="ltx_section">
<h2 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_section">1 </span>Introduction</h2>
<p class="ltx_p">Recurrent neural networks have been the standard approach to sequence modelling for many years.</p>
<p class="ltx_p">We propose a new architecture based entirely on attention mechanisms and without recurrence.</p>
</section>
<section id="S2" class="ltx_section">
<h3 class="ltx_title ltx_title_section"><span class="ltx_tag ltx_tag_subsection">2 </span>Background</h3>
<p class="ltx_p">Sequence models are usually conditioned on an encoder state that compresses the whole input.</p>
</section>
</article></body></html>`;

/** A hand-built PDF with a real page tree, so per-page numbers come from the
 *  file and not from the order streams happened to appear in. */
function pdfDocument(contents: string[], options: { compress?: boolean } = {}): Buffer {
  const objects = new Map<number, string>();
  const kids: string[] = [];
  contents.forEach((content, index) => {
    const contentNumber = 3 + index * 2;
    const pageNumber = contentNumber + 1;
    kids.push(`${pageNumber} 0 R`);
    const body = options.compress
      ? deflateSync(Buffer.from(content, "latin1"))
      : Buffer.from(content, "latin1");
    const filter = options.compress ? " /Filter /FlateDecode" : "";
    objects.set(
      contentNumber,
      `<< /Length ${body.length}${filter} >>\nstream\n${body.toString("latin1")}\nendstream`,
    );
    objects.set(
      pageNumber,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentNumber} 0 R >>`,
    );
  });
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(2, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${contents.length} >>`);
  const parts = ["%PDF-1.4"];
  for (const [number, body] of objects) parts.push(`${number} 0 obj\n${body}\nendobj`);
  parts.push("trailer\n<< /Root 1 0 R >>\n%%EOF");
  return Buffer.from(parts.join("\n"), "latin1");
}

const pdfText = (text: string): string => `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;

/** The metadata check writes this row; the PDF provider only reads the link it
 *  already holds instead of searching for a copy of its own. */
async function seedOaLink(
  cwd: string,
  kind: FullTextRef["kind"],
  id: string,
  oaUrl: string,
): Promise<void> {
  await appendJsonLine(workspaceFile(cwd, "citations.jsonl"), {
    schema: 2,
    kind,
    id,
    status: "found",
    oa_url: oaUrl,
    verified_at: new Date().toISOString(),
  });
}

describe("citation full text", () => {
  it("splits Europe PMC XML into titled sections and paragraphs and stores one file", async () => {
    const cwd = await makeWorkspace();
    const fetchFn = fakeFetch((url) => {
      if (url.host === "www.ebi.ac.uk" && url.pathname.endsWith("/search"))
        return response(epmcSearch(DOI, "PMC7759461"));
      if (url.pathname === "/europepmc/webservices/rest/PMC7759461/fullTextXML")
        return response(epmcXml, 200);
      return undefined;
    });

    const snapshot = await fetchFullTextSnapshot(cwd, doiRef, {
      fetch: fetchFn,
      minimumInterval: FAST,
      lookup: PUBLIC_DNS,
    });

    expect(snapshot.state).toBe("available");
    expect(snapshot.provider).toBe("europepmc");
    expect(snapshot.sections).toEqual([
      { id: "Sec1", title: "Results" },
      { id: "Sec2", title: "Methods" },
    ]);
    expect(snapshot.passages.map((passage) => [passage.section_title, passage.section_id])).toEqual(
      [
        [null, null],
        ["Results", "Sec1"],
        ["Results", "Sec1"],
        ["Methods", "Sec2"],
      ],
    );
    expect(snapshot.passages[1]?.text).toBe(
      "We find that the array programming model gives scientists a compact notation for numeric work.",
    );
    expect(snapshot.license).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(snapshot.content_sha256).toBe(createHash("sha256").update(epmcXml).digest("hex"));

    const stored = JSON.parse(await readFile(fullTextSnapshotPath(cwd, "doi", DOI), "utf8")) as {
      state: string;
      passages: unknown[];
    };
    expect(stored.state).toBe("available");
    expect(stored.passages).toHaveLength(4);
  });

  it("splits arXiv HTML into sections, keeps the section anchor and drops the section number", async () => {
    const cwd = await makeWorkspace();
    const fetchFn = fakeFetch((url) => {
      if (url.host === "www.ebi.ac.uk" && url.pathname.endsWith("/search"))
        return response(epmcMiss);
      if (url.host === "arxiv.org" && url.pathname === "/html/2401.12345")
        return response(arxivHtml);
      return undefined;
    });

    const snapshot = await fetchFullTextSnapshot(cwd, arxivRef(null), {
      fetch: fetchFn,
      minimumInterval: FAST,
      lookup: PUBLIC_DNS,
    });

    expect(snapshot.state).toBe("available");
    expect(snapshot.provider).toBe("arxiv_html");
    expect(snapshot.url).toBe("https://arxiv.org/html/2401.12345");
    expect(snapshot.sections).toEqual([
      { id: "S1", title: "Introduction" },
      { id: "S2", title: "Background" },
    ]);
    expect(snapshot.passages[0]).toMatchObject({ section_title: "Introduction", section_id: "S1" });
    expect(snapshot.passages[0]?.text).toContain("Recurrent neural networks");
  });

  it("extracts the text layer of an uncompressed PDF and numbers the pages", async () => {
    const cwd = await makeWorkspace();
    await seedOaLink(cwd, "doi", DOI, "https://example.org/paper.pdf");
    const first =
      "We measured the runtime of the vectorised kernel on a single workstation and repeated the benchmark ten times so that the scheduler of the operating system would not decide the result.";
    const second =
      "The second page of the file records the configuration of the workstation and the version of every library that the benchmark touched.";
    const fetchFn = fakeFetch((url) => {
      if (url.host === "www.ebi.ac.uk" && url.pathname.endsWith("/search"))
        return response(epmcMiss);
      if (url.host === "example.org" && url.pathname === "/paper.pdf")
        return response(pdfDocument([pdfText(first), pdfText(second)]));
      return undefined;
    });

    const snapshot = await fetchFullTextSnapshot(cwd, doiRef, {
      fetch: fetchFn,
      minimumInterval: FAST,
      lookup: PUBLIC_DNS,
    });

    expect(snapshot.state).toBe("available");
    expect(snapshot.provider).toBe("open_pdf");
    expect(
      snapshot.passages.filter((passage) => passage.page === 1).map((passage) => passage.text),
    ).toEqual([first]);
    expect(
      snapshot.passages.filter((passage) => passage.page === 2).map((passage) => passage.text),
    ).toEqual([second]);
    expect(snapshot.sections).toEqual([]);
  });

  it("inflates FlateDecode text streams before reading them", async () => {
    const cwd = await makeWorkspace();
    await seedOaLink(cwd, "doi", DOI, "https://example.org/compressed.pdf");
    const text =
      "The compressed content stream still holds one readable sentence about the measured throughput of the kernel.";
    const fetchFn = fakeFetch((url) => {
      if (url.host === "www.ebi.ac.uk" && url.pathname.endsWith("/search"))
        return response(epmcMiss);
      if (url.host === "example.org" && url.pathname === "/compressed.pdf")
        return response(pdfDocument([pdfText(text)], { compress: true }));
      return undefined;
    });

    const snapshot = await fetchFullTextSnapshot(cwd, doiRef, {
      fetch: fetchFn,
      minimumInterval: FAST,
      lookup: PUBLIC_DNS,
    });

    expect(snapshot.state).toBe("available");
    expect(snapshot.provider).toBe("open_pdf");
    expect(snapshot.passages.map((passage) => passage.text)).toEqual([text]);
  });

  it("reports no_open_fulltext with the providers it tried", async () => {
    const cwd = await makeWorkspace();
    const fetchFn = fakeFetch((url) =>
      url.host === "www.ebi.ac.uk" && url.pathname.endsWith("/search")
        ? response(epmcMiss)
        : undefined,
    );

    const snapshot = await fetchFullTextSnapshot(cwd, doiRef, {
      fetch: fetchFn,
      minimumInterval: FAST,
      lookup: PUBLIC_DNS,
    });

    expect(snapshot.state).toBe("no_open_fulltext");
    expect(snapshot.provider).toBeNull();
    expect(snapshot.note).toContain("europepmc");
    expect(snapshot.note).toContain("open_pdf");
  });

  it("reports access_denied instead of no such paper", async () => {
    const cwd = await makeWorkspace();
    const fetchFn = fakeFetch((url) =>
      url.host === "www.ebi.ac.uk" && url.pathname.endsWith("/search")
        ? response("forbidden", 403)
        : undefined,
    );

    const snapshot = await fetchFullTextSnapshot(cwd, doiRef, {
      fetch: fetchFn,
      minimumInterval: FAST,
      lookup: PUBLIC_DNS,
    });

    expect(snapshot.state).toBe("access_denied");
    expect(snapshot.note).toContain("HTTP 403");
  });

  it("reports download_failed when the request never arrives", async () => {
    const cwd = await makeWorkspace();
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });

    const snapshot = await fetchFullTextSnapshot(cwd, doiRef, {
      fetch: fetchFn as unknown as typeof fetch,
      minimumInterval: FAST,
      lookup: PUBLIC_DNS,
    });

    expect(snapshot.state).toBe("download_failed");
    expect(snapshot.note).toContain("fetch failed");
  });

  it("reports parse_failed when the bytes hold no paragraphs", async () => {
    const cwd = await makeWorkspace();
    const fetchFn = fakeFetch((url) => {
      if (url.host === "www.ebi.ac.uk" && url.pathname.endsWith("/search"))
        return response(epmcSearch(DOI, "PMC7759461"));
      if (url.pathname === "/europepmc/webservices/rest/PMC7759461/fullTextXML")
        return response("<article><body><p>  </p></body></article>");
      return undefined;
    });

    const snapshot = await fetchFullTextSnapshot(cwd, doiRef, {
      fetch: fetchFn,
      minimumInterval: FAST,
      lookup: PUBLIC_DNS,
    });

    expect(snapshot.state).toBe("parse_failed");
    expect(snapshot.note).toContain("no paragraphs");
  });

  it("reports no_text_layer for a PDF without a text layer", async () => {
    const cwd = await makeWorkspace();
    await seedOaLink(cwd, "doi", DOI, "https://example.org/scanned.pdf");
    const fetchFn = fakeFetch((url) => {
      if (url.host === "www.ebi.ac.uk" && url.pathname.endsWith("/search"))
        return response(epmcMiss);
      if (url.host === "example.org" && url.pathname === "/scanned.pdf")
        return response(pdfDocument(["q 1 0 0 1 0 0 cm /Im0 Do Q"]));
      return undefined;
    });

    const snapshot = await fetchFullTextSnapshot(cwd, doiRef, {
      fetch: fetchFn,
      minimumInterval: FAST,
      lookup: PUBLIC_DNS,
    });

    expect(snapshot.state).toBe("no_text_layer");
    expect(snapshot.passages).toEqual([]);
  });

  it("refuses another arXiv version's text", async () => {
    const cwd = await makeWorkspace();
    const declared = arxivHtml.replace(
      '<article class="ltx_document">',
      '<article class="ltx_document"><img src="2401.12345v7/Figures/model.png">',
    );
    const fetchFn = fakeFetch((url) => {
      if (url.host === "www.ebi.ac.uk" && url.pathname.endsWith("/search"))
        return response(epmcMiss);
      if (url.host === "arxiv.org" && url.pathname === "/html/2401.12345v2")
        return response(declared);
      return undefined;
    });

    const snapshot = await fetchFullTextSnapshot(cwd, arxivRef("2"), {
      fetch: fetchFn,
      minimumInterval: FAST,
      lookup: PUBLIC_DNS,
    });

    expect(snapshot.state).toBe("version_mismatch");
    expect(snapshot.passages).toEqual([]);
    expect(snapshot.note).toContain("v7");
  });

  it("reuses a fresh snapshot and refetches a stale one", async () => {
    const cwd = await makeWorkspace();
    const handler = (url: URL) => {
      if (url.host === "www.ebi.ac.uk" && url.pathname.endsWith("/search"))
        return response(epmcSearch(DOI, "PMC7759461"));
      if (url.pathname === "/europepmc/webservices/rest/PMC7759461/fullTextXML")
        return response(epmcXml);
      return undefined;
    };
    // Ahead of any clock an earlier test recorded, so the throttle never waits.
    const now = Date.now() + 60_000;
    const first = fakeFetch(handler);
    await fetchFullTextSnapshot(cwd, doiRef, {
      fetch: first,
      now: () => now,
      minimumInterval: FAST,
      lookup: PUBLIC_DNS,
    });
    expect(first).toHaveBeenCalledTimes(2);

    const second = fakeFetch(handler);
    const fresh = await fullTextSnapshot(
      cwd,
      doiRef,
      {},
      { fetch: second, now: () => now + 1_000, minimumInterval: FAST, lookup: PUBLIC_DNS },
    );
    expect(second).not.toHaveBeenCalled();
    expect(fresh?.provider).toBe("europepmc");

    const third = fakeFetch(handler);
    const stale = await fullTextSnapshot(
      cwd,
      doiRef,
      {},
      {
        fetch: third,
        now: () => now + 31 * 24 * 60 * 60 * 1_000,
        minimumInterval: FAST,
        lookup: PUBLIC_DNS,
      },
    );
    expect(third).toHaveBeenCalledTimes(2);
    expect(stale?.state).toBe("available");
  });

  it("reads nothing from the network when fetch is false", async () => {
    const cwd = await makeWorkspace();
    const fetchFn = vi.fn(async () => response("unused"));

    const missing = await fullTextSnapshot(
      cwd,
      doiRef,
      { fetch: false },
      { fetch: fetchFn as unknown as typeof fetch, minimumInterval: FAST, lookup: PUBLIC_DNS },
    );

    expect(missing).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

/** A page that states its own version, so a read of it can be checked against
 *  the version the citation asked for. */
function arxivVersionPage(version: string, sentence: string): string {
  return `<!DOCTYPE html><html><body>
<article class="ltx_document"><img src="2401.12345v${version}/Figures/model.png">
<section id="S1" class="ltx_section"><h2>Results</h2>
<p class="ltx_p">${sentence}</p>
</section></article></body></html>`;
}

const V1_SENTENCE =
  "The first version reports that the encoder adds no recurrent state of its own to the model.";
const V2_SENTENCE =
  "The second version reports that the encoder was replaced by a convolutional stem in every experiment.";

function arxivVersionFetch() {
  const pages: Record<string, string> = {
    "1": arxivVersionPage("1", V1_SENTENCE),
    "2": arxivVersionPage("2", V2_SENTENCE),
  };
  return fakeFetch((url) => {
    if (url.host === "www.ebi.ac.uk" && url.pathname.endsWith("/search")) return response(epmcMiss);
    if (url.host !== "arxiv.org") return undefined;
    const version = /^\/html\/2401\.12345v(\d+)$/.exec(url.pathname)?.[1];
    return version ? response(pages[version] ?? "") : undefined;
  });
}

function storedArxivSnapshot(version: string, sentence: string): FullTextSnapshot {
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
    content_sha256: createHash("sha256").update(sentence).digest("hex"),
    license: null,
    sections: [{ id: "S1", title: "Results" }],
    passages: [
      { index: 0, section_title: "Results", section_id: "S1", page: null, text: sentence },
    ],
  };
}

describe("citation full text version isolation", () => {
  it("keeps each arXiv version in its own cache and answers the version that was asked for", async () => {
    const cwd = await makeWorkspace();
    const fetchFn = arxivVersionFetch();
    // Both reads land well inside one freshness window, which is exactly when a
    // version-blind cache would have answered the second read with the first text.
    const now = Date.now() + 60_000;

    const v1 = await fullTextSnapshot(
      cwd,
      arxivRef("1"),
      {},
      { fetch: fetchFn, lookup: PUBLIC_DNS, now: () => now, minimumInterval: FAST },
    );
    expect(v1?.requested_version).toBe("1");
    expect(v1?.passages[0]?.text).toBe(V1_SENTENCE);

    const v2 = await fullTextSnapshot(
      cwd,
      arxivRef("2"),
      {},
      { fetch: fetchFn, lookup: PUBLIC_DNS, now: () => now + 1_000, minimumInterval: FAST },
    );
    expect(v2?.requested_version).toBe("2");
    expect(v2?.passages[0]?.text).toBe(V2_SENTENCE);
    expect(v2?.url).toBe("https://arxiv.org/html/2401.12345v2");
    expect(snapshotIdOf(v2!)).not.toBe(snapshotIdOf(v1!));

    const reread = await fullTextSnapshot(
      cwd,
      arxivRef("1"),
      {},
      { fetch: fetchFn, lookup: PUBLIC_DNS, now: () => now + 2_000, minimumInterval: FAST },
    );
    expect(reread?.requested_version).toBe("1");
    expect(reread?.passages[0]?.text).toBe(V1_SENTENCE);
    expect(reread?.url).toBe("https://arxiv.org/html/2401.12345v1");
  });

  it("does not answer a version from a versionless snapshot another version wrote", async () => {
    const cwd = await makeWorkspace();
    await writeJsonAtomic(
      fullTextSnapshotPath(cwd, "arxiv", "2401.12345"),
      storedArxivSnapshot("1", V1_SENTENCE),
    );

    const v2 = await fullTextSnapshot(
      cwd,
      arxivRef("2"),
      { fetch: false },
      { lookup: PUBLIC_DNS, minimumInterval: FAST },
    );

    expect(v2).toBeNull();
  });

  it("reads back the stored text of the exact version the citation asked for", async () => {
    const cwd = await makeWorkspace();
    const v1 = storedArxivSnapshot("1", V1_SENTENCE);
    await writeJsonAtomic(fullTextSnapshotPath(cwd, "arxiv", "2401.12345", "1"), v1);
    await writeJsonAtomic(
      fullTextSnapshotPath(cwd, "arxiv", "2401.12345", "2"),
      storedArxivSnapshot("2", V2_SENTENCE),
    );

    const one = await fullTextSnapshot(
      cwd,
      arxivRef("1"),
      { fetch: false },
      { lookup: PUBLIC_DNS, minimumInterval: FAST },
    );
    const two = await fullTextSnapshot(
      cwd,
      arxivRef("2"),
      { fetch: false },
      { lookup: PUBLIC_DNS, minimumInterval: FAST },
    );

    expect(one?.passages[0]?.text).toBe(V1_SENTENCE);
    expect(two?.passages[0]?.text).toBe(V2_SENTENCE);
  });
});

/** Enough bytes to pass any real paper, with no Content-Length to pre-check. */
function oversizedStream(): Response {
  const chunk = new Uint8Array(1024 * 1024);
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(stream) {
      if (sent >= 40) {
        stream.close();
        return;
      }
      sent += 1;
      stream.enqueue(chunk);
    },
  });
  return new Response(body, { status: 200 });
}

function redirectTo(location: string): Response {
  return {
    ok: false,
    status: 302,
    headers: new Headers({ location }),
    body: null,
  } as unknown as Response;
}

describe("citation full text outbound policy", () => {
  const BLOCKED = [
    "http://127.0.0.1:8080/paper.pdf",
    "http://10.1.2.3/paper.pdf",
    "http://172.16.0.9/paper.pdf",
    "http://192.168.1.10/paper.pdf",
    "http://169.254.169.254/paper.pdf",
    "http://[::1]/paper.pdf",
    "http://[fd00::1]/paper.pdf",
    "http://[fe80::1]/paper.pdf",
  ];

  it.each(BLOCKED)("never sends a request to %s", async (link) => {
    const cwd = await makeWorkspace();
    await seedOaLink(cwd, "doi", DOI, link);
    const fetchFn = fakeFetch((url) =>
      url.host === "www.ebi.ac.uk" && url.pathname.endsWith("/search")
        ? response(epmcMiss)
        : undefined,
    );

    const snapshot = await fetchFullTextSnapshot(cwd, doiRef, {
      fetch: fetchFn,
      lookup: PUBLIC_DNS,
      minimumInterval: FAST,
    });

    const reached = fetchFn.mock.calls.map(([input]) => new URL(String(input)).host);
    expect(reached).not.toContain(new URL(link).host);
    expect(snapshot.state).toBe("download_failed");
    expect(snapshot.note).toContain("private or reserved address");
  });

  it("never follows an open-access link that redirects into a private address", async () => {
    const cwd = await makeWorkspace();
    await seedOaLink(cwd, "doi", DOI, "https://example.org/redirect.pdf");
    const fetchFn = fakeFetch((url) => {
      if (url.host === "www.ebi.ac.uk" && url.pathname.endsWith("/search"))
        return response(epmcMiss);
      if (url.host === "example.org" && url.pathname === "/redirect.pdf")
        return redirectTo("http://10.0.0.5/secret.pdf");
      return undefined;
    });

    const snapshot = await fetchFullTextSnapshot(cwd, doiRef, {
      fetch: fetchFn,
      lookup: PUBLIC_DNS,
      minimumInterval: FAST,
    });

    expect(fetchFn.mock.calls.map(([input]) => new URL(String(input)).host)).not.toContain(
      "10.0.0.5",
    );
    expect(snapshot.state).toBe("download_failed");
    expect(snapshot.note).toContain("private or reserved address");
  });

  it("stops reading an open-access PDF that declares more bytes than the limit", async () => {
    const cwd = await makeWorkspace();
    await seedOaLink(cwd, "doi", DOI, "https://example.org/huge.pdf");
    const huge = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "999999999" }),
      body: null,
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
    const fetchFn = fakeFetch((url) => {
      if (url.host === "www.ebi.ac.uk" && url.pathname.endsWith("/search"))
        return response(epmcMiss);
      if (url.host === "example.org" && url.pathname === "/huge.pdf") return huge;
      return undefined;
    });

    const snapshot = await fetchFullTextSnapshot(cwd, doiRef, {
      fetch: fetchFn,
      lookup: PUBLIC_DNS,
      minimumInterval: FAST,
    });

    expect(snapshot.state).toBe("download_failed");
    expect(snapshot.note).toContain("size limit");
  });

  it("stops reading an open-access PDF that streams past the limit with no Content-Length", async () => {
    const cwd = await makeWorkspace();
    await seedOaLink(cwd, "doi", DOI, "https://example.org/stream.pdf");
    const fetchFn = fakeFetch((url) => {
      if (url.host === "www.ebi.ac.uk" && url.pathname.endsWith("/search"))
        return response(epmcMiss);
      if (url.host === "example.org" && url.pathname === "/stream.pdf") return oversizedStream();
      return undefined;
    });

    const snapshot = await fetchFullTextSnapshot(cwd, doiRef, {
      fetch: fetchFn,
      lookup: PUBLIC_DNS,
      minimumInterval: FAST,
    });

    expect(snapshot.state).toBe("download_failed");
    expect(snapshot.note).toContain("size limit");
  });
});
