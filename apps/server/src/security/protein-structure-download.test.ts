import { describe, expect, it, vi } from "vitest";
import { resolveProteinStructure, verifiedProteinIdentity } from "./protein-structure-download.js";

describe("protein structure resolution", () => {
  it("requires a complete matching UniProt identity before downloading", () => {
    const record = { retrieved_at: "2026-09-28T13:00:00Z", record: { accession: "P30520", protein_name: "Adenylosuccinate synthetase isozyme 2", genes: ["ADSS2"], organism: { scientificName: "Homo sapiens", taxonId: 9606 }, sequence: { length: 456 } } };
    expect(verifiedProteinIdentity(record, "P30520")).toMatchObject({ protein_name: "Adenylosuccinate synthetase isozyme 2", organism_name: "Homo sapiens", sequence_length: 456, genes: ["ADSS2"] });
    expect(() => verifiedProteinIdentity({ ...record, record: { ...record.record, accession: "P30521" } }, "P30520")).toThrow(/complete identity/);
  });

  it("selects one exact UniProt-linked experimental structure", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result_set: [{ identifier: "2V40" }] }), { status: 200 }));
    const result = await resolveProteinStructure("p30520", "best_available", fetch);
    expect(result).toMatchObject({ source: "experimental", structure_id: "2V40", destination: "structures/P30520/2V40.cif" });
    const query = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(query.query.parameters).toMatchObject({ operator: "exact_match", value: "P30520" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("uses a matching AlphaFold model when no experimental structure exists", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ uniprotAccession: "P30520", entryId: "AF-P30520-F1", cifUrl: "https://alphafold.ebi.ac.uk/files/AF-P30520-F1-model_v6.cif" }]), { status: 200 }));
    const result = await resolveProteinStructure("P30520", "best_available", fetch);
    expect(result).toMatchObject({ source: "predicted", structure_id: "AF-P30520-F1", destination: "structures/P30520/AF-P30520-F1-model_v6.cif" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("retries a transient RCSB failure before falling back to AlphaFold", async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result_set: [{ identifier: "2V40" }] }), { status: 200 }));
    const result = await resolveProteinStructure("P30520", "best_available", fetch);
    expect(result.source).toBe("experimental");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects an AlphaFold response that points outside its file origin", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ uniprotAccession: "P30520", entryId: "AF-P30520-F1", cifUrl: "https://private.example/AF-P30520-F1-model_v6.cif" }]), { status: 200 }));
    await expect(resolveProteinStructure("P30520", "predicted", fetch)).rejects.toThrow(/unexpected structure URL/);
  });
});
