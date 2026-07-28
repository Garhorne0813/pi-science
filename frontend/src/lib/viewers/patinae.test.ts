import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserSupportsWebGpu,
  defaultViewerKind,
  extensionOf,
  initialPatinaeCommands,
  patinaeFormatFor,
  patinaeObjectName,
  supportsPatinaeFile,
} from "./patinae";

describe("Patinae viewer helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("normalizes compressed filenames and maps supported formats", () => {
    expect(extensionOf("/workspace/protein.PDB.gz")).toBe("pdb");
    expect(patinaeFormatFor("protein.mmcif")).toBe("cif");
    expect(patinaeFormatFor("ligand.mol2")).toBe("mol2");
    expect(patinaeFormatFor("ligand.pqr")).toBeNull();
    expect(supportsPatinaeFile("structure.xyz")).toBe(true);
  });

  it("creates a stable object name for viewer commands", () => {
    expect(patinaeObjectName("/tmp/1abc protein.cif.gz")).toBe("1abc_protein");
    expect(patinaeObjectName("...")).toBe("structure");
  });

  it("only prefers Patinae for large supported structures with WebGPU", () => {
    expect(
      defaultViewerKind({ filename: "protein.pdb", isMacromolecule: true, webGpuAvailable: true }),
    ).toBe("patinae");
    expect(
      defaultViewerKind({ filename: "ligand.sdf", isMacromolecule: false, webGpuAvailable: true }),
    ).toBe("3dmol");
    expect(
      defaultViewerKind({ filename: "protein.pqr", isMacromolecule: true, webGpuAvailable: true }),
    ).toBe("3dmol");
    expect(
      defaultViewerKind({ filename: "protein.pdb", isMacromolecule: true, webGpuAvailable: false }),
    ).toBe("3dmol");
  });

  it("returns conservative initial commands", () => {
    expect(initialPatinaeCommands(true)).toEqual(["as cartoon", "show sticks, organic", "orient"]);
    expect(initialPatinaeCommands(false)).toEqual(["as sticks", "orient"]);
  });

  it("detects WebGPU without throwing in a non-browser test environment", () => {
    vi.stubGlobal("navigator", { gpu: {} });
    expect(browserSupportsWebGpu()).toBe(true);
    vi.stubGlobal("navigator", {});
    expect(browserSupportsWebGpu()).toBe(false);
  });
});
