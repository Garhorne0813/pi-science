import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetThrottle, searchArxiv, searchGenBank, searchPubChem, searchPubMed, searchUniProt } from "./providers.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (hostname: string) => [{ address: "93.184.216.34", family: 4 }]),
}));

const ARXIV_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2301.01234v2</id>
    <title>Example &amp; title for the test</title>
    <published>2023-01-03T18:59:24Z</published>
    <author><name>Alice Doe</name></author>
    <author><name>Bob Roe</name></author>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2402.05555</id>
    <title>Second paper</title>
    <published>2024-02-05T00:00:00Z</published>
    <author><name>Carol Lin</name></author>
  </entry>
</feed>`;

const PUBMED_SEARCH = JSON.stringify({ esearchresult: { idlist: ["38218210", "38218211"] } });
const PUBMED_SUMMARY = JSON.stringify({
  result: {
    uids: ["38218210", "38218211"],
    "38218210": {
      uid: "38218210",
      title: "Example biomedical paper",
      pubdate: "2024 Jan 10",
      source: "Journal of Test Science",
      authors: [{ name: "Doe J" }],
      articleids: [{ idtype: "doi", value: "10.1000/xyz" }],
    },
    "38218211": { uid: "38218211", title: "Second paper", pubdate: "2023", authors: [], source: "J Test" },
  },
});

const GENBANK_SEARCH = JSON.stringify({ esearchresult: { idlist: ["123456"] } });
const GENBANK_SUMMARY = JSON.stringify({
  result: { uids: ["123456"], "123456": { uid: "123456", caption: "AB123456.1", title: "Example gene", pubdate: "2023" } },
});

const PUBCHEM_CIDS = JSON.stringify({ IdentifierList: { CID: [1234, 5678] } });
const PUBCHEM_PROPS = JSON.stringify({
  PropertyTable: {
    Properties: [
      { CID: 1234, MolecularFormula: "C6H12O6", MolecularWeight: 180.16, IUPACName: "glucose" },
      { CID: 5678, MolecularFormula: "C12H22O11", MolecularWeight: 342.3, IUPACName: "sucrose" },
    ],
  },
});

const UNIPROT_JSON = JSON.stringify({
  results: [
    {
      primaryAccession: "P12345",
      uniProtkbId: "EXMP_HUMAN",
      proteinDescription: { recommendedName: { fullName: { value: "Example protein" } } },
      organism: { scientificName: "Homo sapiens" },
      genes: [{ geneName: { value: "EXMP" } }],
    },
  ],
});

let fetchMock: ReturnType<typeof vi.fn>;
let currentUrl = "";

function stubFetch(routes: Array<{ match: RegExp | string; body: string | Response }>) {
  currentUrl = "";
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input.toString() : String(input);
    currentUrl = url;
    const route = routes.find((entry) => (typeof entry.match === "string" ? url.includes(entry.match) : entry.match.test(url)));
    if (!route) return new Response("not found", { status: 404 });
    return typeof route.body === "string" ? new Response(route.body, { status: 200, headers: { "content-type": "application/json" } }) : route.body;
  });
  vi.stubGlobal("fetch", fetchMock);
}

let auditDir = "";

beforeEach(() => {
  resetThrottle();
  // Isolate egress audit writes: never touch the real ~/.pi-science config root.
  auditDir = mkdtempSync(join(tmpdir(), "pi-lit-providers-"));
  process.env.PI_SCIENCE_HOME = auditDir;
});

afterEach(() => {
  delete process.env.PI_SCIENCE_HOME;
  if (auditDir) rmSync(auditDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe("searchPubMed", () => {
  it("parses esearch + esummary into normalized records", async () => {
    stubFetch([
      { match: "esearch.fcgi", body: PUBMED_SEARCH },
      { match: "esummary.fcgi", body: PUBMED_SUMMARY },
    ]);
    const { result, rawBodies } = await searchPubMed("crispr", { approved: false });
    expect(result.provider).toBe("pubmed");
    expect(result.records).toHaveLength(2);
    const first = result.records[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(first).toMatchObject({ id: "38218210", provider: "pubmed", title: "Example biomedical paper", doi: "10.1000/xyz", venue: "Journal of Test Science", year: 2024 });
    expect(first.authors).toEqual(["Doe J"]);
    expect(first.url).toBe("https://pubmed.ncbi.nlm.nih.gov/38218210/");
    expect(result.responseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rawBodies).toHaveLength(2);
  });

  it("returns an empty result when esearch finds nothing", async () => {
    stubFetch([{ match: "esearch.fcgi", body: JSON.stringify({ esearchresult: { idlist: [] } }) }]);
    const { result } = await searchPubMed("no such thing", { approved: false });
    expect(result.hitCount).toBe(0);
    expect(result.records).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to reach providers that resolve to private addresses", async () => {
    const { lookup } = await import("node:dns/promises");
    // The dns.lookup overload set makes vi.mocked infer the non-all signature;
    // the real call site uses { all: true }, so the mock returns an array.
    vi.mocked(lookup).mockImplementationOnce((async () => [{ address: "10.0.0.1", family: 4 }]) as never);
    stubFetch([{ match: "esearch.fcgi", body: PUBMED_SEARCH }]);
    await expect(searchPubMed("crispr", { approved: false })).rejects.toThrow(/private or reserved/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("searchGenBank", () => {
  it("queries the nuccore database and exposes the accession", async () => {
    stubFetch([
      { match: "esearch.fcgi", body: GENBANK_SEARCH },
      { match: "esummary.fcgi", body: GENBANK_SUMMARY },
    ]);
    const { result } = await searchGenBank("TP53", { approved: false });
    expect(currentUrl).toContain("db=nuccore");
    expect(result.records[0]).toMatchObject({ id: "AB123456.1", provider: "genbank", title: "Example gene", url: "https://www.ncbi.nlm.nih.gov/nuccore/AB123456.1" });
    expect(result.records[0]?.extra).toEqual({ database: "GenBank" });
  });
});

describe("searchArxiv", () => {
  it("parses Atom XML entries and canonicalizes arXiv ids", async () => {
    stubFetch([{ match: "export.arxiv.org", body: ARXIV_XML }]);
    const { result } = await searchArxiv("perovskite solar cell", { approved: false });
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({ id: "2301.01234", provider: "arxiv", title: "Example & title for the test", year: 2023, url: "https://arxiv.org/abs/2301.01234" });
    expect(result.records[0]?.authors).toEqual(["Alice Doe", "Bob Roe"]);
    expect(result.records[1]?.id).toBe("2402.05555");
  });
});

describe("searchPubChem", () => {
  it("resolves a compound name to CIDs and properties", async () => {
    stubFetch([
      { match: "cids/JSON", body: PUBCHEM_CIDS },
      { match: "property", body: PUBCHEM_PROPS },
    ]);
    const { result } = await searchPubChem("glucose", { approved: false });
    expect(result.records).toHaveLength(2);
    expect(result.records[0]).toMatchObject({
      id: "1234",
      provider: "pubchem",
      title: "glucose",
      url: "https://pubchem.ncbi.nlm.nih.gov/compound/1234",
    });
    expect(result.records[0]?.extra).toEqual({ molecularFormula: "C6H12O6", molecularWeight: 180.16 });
  });
});

describe("searchUniProt", () => {
  it("parses the UniProtKB search response", async () => {
    stubFetch([{ match: "rest.uniprot.org", body: UNIPROT_JSON }]);
    const { result } = await searchUniProt("TP53 human", { approved: false });
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({
      id: "P12345",
      provider: "uniprot",
      title: "Example protein",
      venue: "Homo sapiens",
      url: "https://www.uniprot.org/uniprotkb/P12345/entry",
    });
    expect(result.records[0]?.extra).toEqual({ uniprotId: "EXMP_HUMAN", gene: "EXMP" });
  });
});
