export type MoleculeViewerKind = "3dmol" | "patinae";

const PATINAE_FORMATS: Record<string, string> = {
  pdb: "pdb",
  cif: "cif",
  mcif: "cif",
  mmcif: "cif",
  mol: "mol",
  mol2: "mol2",
  sdf: "sdf",
  xyz: "xyz",
};

export function extensionOf(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? filename;
  const clean = basename.replace(/\.(gz|bz2)$/i, "");
  const dot = clean.lastIndexOf(".");
  return dot >= 0 ? clean.slice(dot + 1).toLowerCase() : "";
}

export function patinaeFormatFor(filename: string): string | null {
  return PATINAE_FORMATS[extensionOf(filename)] ?? null;
}

export function patinaeObjectName(filename: string): string {
  const basename = filename.split(/[\\/]/).pop() ?? filename;
  const base = basename
    .replace(/\.(gz|bz2)$/i, "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return base || "structure";
}

export function supportsPatinaeFile(filename: string): boolean {
  return patinaeFormatFor(filename) !== null;
}

export function browserSupportsWebGpu(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.gpu);
}

export function initialPatinaeCommands(isMacromolecule: boolean): string[] {
  return isMacromolecule
    ? ["as cartoon", "show sticks, organic", "orient"]
    : ["as sticks", "orient"];
}

export function defaultViewerKind(options: {
  filename: string;
  isMacromolecule: boolean;
  webGpuAvailable: boolean;
}): MoleculeViewerKind {
  if (!options.webGpuAvailable) return "3dmol";
  if (!supportsPatinaeFile(options.filename)) return "3dmol";
  return options.isMacromolecule ? "patinae" : "3dmol";
}
