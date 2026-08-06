// Turn the agent's file-writing tool calls into traceable artifacts.
// Pure and transport-agnostic so it can be unit-tested without a live runtime.

// Types are imported from the canonical source in types/thread.ts — no duplicates.
import type {
  ArtifactKind,
  ArtifactBlock,
  ArtifactVersion,
  ArtifactInspector,
  FileRoot,
  FilePreviewInspector,
  NotebookFileInspector,
  ThreadBlock,
} from "../../types/thread";

// Re-export so existing imports from artifacts.ts keep working
export type { ArtifactKind, ArtifactBlock, ArtifactVersion, ArtifactInspector, FilePreviewInspector, NotebookFileInspector };

const EXT_KIND: Record<string, ArtifactKind> = {
  png: "figure", jpg: "figure", jpeg: "figure", gif: "figure", webp: "figure", svg: "figure",
  fits: "figure", fit: "figure", fts: "figure",
  mp4: "figure", webm: "figure", mov: "figure", m4v: "figure", ogv: "figure",
  py: "script", r: "script", jl: "script", sh: "script",
  ipynb: "notebook",
  pdf: "report", tex: "report", md: "report", docx: "report", docm: "report", dotx: "report", pptx: "report", pptm: "report", potx: "report",
  csv: "table", tsv: "table", parquet: "table", xlsx: "table", xlsm: "table", xltx: "table",
  mol: "data", sdf: "data", smi: "data", smiles: "data",
  bed: "data", bedgraph: "data", bdg: "data", gff: "data", gff3: "data", gtf: "data", vcf: "data",
  stl: "model", obj: "model", ply: "model", gltf: "model", glb: "model",
  dos: "data", qcode: "data", anom: "figure", eigenval: "data", phase: "figure",
};

const EXT_LANG: Record<string, string> = {
  py: "python", r: "r", jl: "julia", sh: "bash",
  tex: "latex", md: "markdown", csv: "plaintext", tsv: "plaintext",
};

function extToKind(ext: string): ArtifactKind {
  return EXT_KIND[ext.toLowerCase()] ?? "data";
}

/** Extensions we treat as workspace artifacts worth surfacing/previewing. */
const REF_EXTS = [
  "pdf", "html", "htm", "svg", "png", "jpg", "jpeg", "gif", "webp",
  "csv", "tsv", "md", "tex", "json", "py", "ipynb", "r",
  "docx", "docm", "dotx", "xlsx", "xlsm", "xltx", "pptx", "pptm", "potx",
  "mp4", "webm", "mov", "m4v",
  "mol", "mol2", "sdf", "smi", "smiles", "cif", "mcif", "mmcif", "pdb", "pqr", "xyz", "cube",
  "bed", "bedgraph", "bdg", "gff", "gff3", "gtf", "vcf",
  "stl", "obj", "ply", "gltf", "glb",
];
const REF_RE = new RegExp(`[\\w./-]+\\.(?:${REF_EXTS.join("|")})\\b`, "gi");

/**
 * Extract workspace file paths mentioned in an agent message so a file produced by
 * running code (e.g. `canvas-project/canvas.pdf` from a python run) becomes clickable,
 * not just prose. Strips surrounding backticks/quotes; dedupes; ignores URLs.
 */
export function extractArtifactRefs(markdown: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of markdown.matchAll(REF_RE)) {
    const raw = m[0].replace(/^[`'"(]+|[`'".,)]+$/g, "");
    if (!raw || /^https?:\/\//i.test(raw) || raw.startsWith("//")) continue;
    // A bare filename in prose may only be an example (for example main.py or
    // SKILL.md). Tool events and the file browser surface real root-level files;
    // chat text needs an explicit directory component before it is clickable.
    if (!raw.includes("/")) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

/** Normalize the path spelling used by runtime artifact events and chat text. */
export function normalizeArtifactPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

/**
 * Paths emitted by an artifact publication event are authoritative. A path
 * mentioned in prose can be a plan, an example, or a future output and must
 * not become a file link until the runtime has actually published it.
 */
export function publishedArtifactPaths(blocks: readonly ThreadBlock[]): Set<string> {
  return new Set(
    blocks.flatMap((block) => (
      block.kind === "status-line" && block.level === "done" && block.path
        ? [normalizeArtifactPath(block.path)]
        : []
    )),
  );
}

export function publishedArtifactRefs(
  refs: readonly string[],
  blocks: readonly ThreadBlock[],
): string[] {
  const published = publishedArtifactPaths(blocks);
  return refs.filter((ref) => published.has(normalizeArtifactPath(ref)));
}

export function extOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

export type PreviewKind =
  | "html"
  | "pdf"
  | "image"
  | "video"
  | "table"
  | "markdown"
  | "text"
  | "docx"
  | "xlsx"
  | "pptx"
  | "molecule"
  | "mesh"
  | "genome"
  | "fits"
  | "dos"
  | "qcode"
  | "anomaly"
  | "bands"
  | "phase";

/** 3D mesh / CAD formats rendered by the three.js viewer. */
const MESH_EXTS = ["stl", "obj", "ply", "gltf", "glb"];

/** FITS astronomy formats rendered by the native FITS viewer. */
const FITS_EXTS = ["fits", "fit", "fts"];

/** How a file should be previewed, from its extension. This is the previewer
 *  registry: native webview viewers first (pdf/html/image via the local file
 *  server), lightweight JS renderers second (csv table, docx/xlsx/pptx via
 *  lazy-loaded local renderers), code/text fallback. */
export function previewKind(ext: string): PreviewKind {
  const e = ext.toLowerCase();
  if (e === "html" || e === "htm") return "html";
  if (e === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(e)) return "image";
  if (["mp4", "webm", "mov", "m4v", "ogv"].includes(e)) return "video";
  if (e === "csv" || e === "tsv") return "table";
  if (e === "md" || e === "markdown") return "markdown";
  if (["docx", "docm", "dotx"].includes(e)) return "docx";
  if (["xlsx", "xlsm", "xltx"].includes(e)) return "xlsx";
  if (["pptx", "pptm", "potx"].includes(e)) return "pptx";
  if (MESH_EXTS.includes(e)) return "mesh";
  if (FITS_EXTS.includes(e)) return "fits";
  if (e === "dos") return "dos";
  if (e === "qcode") return "qcode";
  if (e === "anom") return "anomaly";
  if (e === "eigenval") return "bands";
  if (e === "phase") return "phase";
  if (["mol", "mol2", "sdf", "smi", "smiles", "cif", "mcif", "mmcif", "pdb", "pqr", "xyz", "cube"].includes(e))
    return "molecule";
  if (["bed", "bedgraph", "bdg", "gff", "gff3", "gtf", "vcf"].includes(e)) return "genome";
  return "text";
}

/** Some scientific tools use fixed, extensionless filenames (VASP DOSCAR, …).
 *  Prefer a name match, else fall back to the extension registry. */
export function previewKindForName(filename: string): PreviewKind {
  const base = (filename.split(/[\\/]/).pop() ?? filename).toLowerCase();
  if (base === "doscar" || base.startsWith("doscar.")) return "dos";
  if (base === "eigenval" || base.startsWith("eigenval.")) return "bands";
  return previewKind(extOf(filename));
}

/** Build a previewable file-inspector from an artifact surfaced in the thread. */
export function fileInspectorFromBlock(
  a: ArtifactBlock,
): FilePreviewInspector | NotebookFileInspector {
  const path = a.path ?? a.filename;
  const inspector = fileInspectorForPath(path, a.filename);
  if (inspector.variant === "notebook-file") return inspector;
  return {
    ...inspector,
    artifact: a.artifact,
    language: a.language ?? EXT_LANG[extOf(a.filename)],
    content: a.content,
  };
}

/** Build the correct inspector for any workspace path. */
export function fileInspectorForPath(
  path: string,
  filename = path.split(/[\\/]/).pop() || path,
  root?: FileRoot,
  cwd?: string,
): FilePreviewInspector | NotebookFileInspector {
  if (extOf(filename) === "ipynb") {
    return { variant: "notebook-file", path, root, cwd };
  }
  return {
    variant: "file",
    path,
    filename,
    root,
    cwd,
    artifact: extToKind(extOf(filename)),
    language: EXT_LANG[extOf(filename)],
  };
}

/** A minimal artifact block for a file referenced in prose (path only, no inline content). */
export function refToArtifactBlock(path: string): ArtifactBlock {
  const filename = path.split(/[\\/]/).pop() || path;
  return {
    kind: "artifact",
    id: `ref-${path}`,
    path,
    filename,
    artifact: extToKind(extOf(filename)),
    tool: "output",
    language: EXT_LANG[extOf(filename)],
  };
}

/** Resolve the content shown for the active version, falling back to inspector-level fields. */
export function resolveArtifactContent(
  data: ArtifactInspector,
  activeVersion: string,
): {
  code: string;
  executionLog?: string;
  messages?: string[];
  environment?: string;
  reviewPassed?: boolean;
} {
  const v: ArtifactVersion | undefined = data.versions.find(
    (version) => version.id === activeVersion || version.label === activeVersion,
  );
  return {
    code: v?.code ?? v?.content ?? data.code ?? "",
    executionLog: v?.executionLog ?? data.executionLog,
    messages: v?.messages ?? data.messages,
    environment: v?.environment ?? data.environment,
    reviewPassed: v?.reviewPassed ?? data.reviewPassed,
  };
}
