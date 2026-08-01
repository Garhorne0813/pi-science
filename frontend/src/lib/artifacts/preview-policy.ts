import type { PreviewKind } from "./artifacts";

export interface PreviewPolicy {
  load: readonly ("url" | "text" | "bytes")[];
  defaultTab: "preview" | "code";
  supportsCode: boolean;
}

const TEXT: PreviewKind[] = ["table", "text", "html", "markdown", "molecule", "genome", "qcode", "anomaly", "phase"];
const BYTES: PreviewKind[] = ["docx", "xlsx", "pptx", "mesh", "fits", "dos", "bands"];
const URL: PreviewKind[] = ["pdf", "image", "html", "video"];
const CODE: PreviewKind[] = ["html", "markdown", "molecule", "genome"];

export function previewPolicy(kind: PreviewKind): PreviewPolicy {
  const load: Array<"url" | "text" | "bytes"> = [];
  if (URL.includes(kind)) load.push("url");
  if (TEXT.includes(kind)) load.push("text");
  if (BYTES.includes(kind)) load.push("bytes");
  return {
    load,
    defaultTab: kind === "text" ? "code" : "preview",
    supportsCode: CODE.includes(kind),
  };
}
