import { pathLeaf } from "../workspace";
import { stripSubagentMentionBlock } from "../conversation/subagent-mentions";
import { stripQuotedMessageBlocks } from "../conversation/quoted-message";
import { isImageRegionPath } from "./image-region-path";

export interface WorkspaceReference {
  cwd: string;
  path: string;
  name: string;
  isDir: boolean;
  imageRegion?: string;
}

// Core persists the expanded skill for reproducibility; the user bubble shows the objective.
const SKILL_BLOCK = /^<skill name="([^"]+)" location="[^"]+">\r?\nReferences are relative to [^\n]+\r?\n\r?\n[\s\S]*?\r?\n<\/skill>\s*/;
const RESEARCH_STARTER = /^(?:\/skill:auto-research\s+)?\[Workflow: (?:research_loop|optimize|compare|evaluate|reproduce)\]\r?\n/;
const REFERENCE_BLOCK = /<workspace_references>[\s\S]*?<\/workspace_references>\s*/g;

const REGION_PREFIX = "- image-region (read this PNG for the marked overview above and detail below): ";
const REGION_GUIDANCE = [
  "For image-region references, inspect the lower crop first and use it as the primary visual evidence.",
  "Answer the user's question about the selected region.",
  "Use the upper marked overview to locate the selection and supply context only when needed for that answer.",
  "Explain the full image only if the user explicitly asks for it.",
  "If the crop is insufficient, state what cannot be determined from the selection.",
].join(" ");

export function injectWorkspaceReferences(message: string, references: WorkspaceReference[]): string {
  if (references.length === 0) return message;
  const items = references
    .map((reference) => reference.imageRegion
      ? `${REGION_PREFIX}${JSON.stringify([reference.path, reference.imageRegion]).replace(/</g, "\\u003c")}`
      : `- ${reference.isDir ? "folder" : "file"}: ${JSON.stringify(reference.path)}`)
    .join("\n");
  const guidance = references.some((reference) => reference.imageRegion) ? `${REGION_GUIDANCE}\n` : "";
  return `${message}\n\n<workspace_references>\n${guidance}${items}\n</workspace_references>`.trim();
}

export function visibleUserMessage(message: string): string {
  const skill = message.match(SKILL_BLOCK);
  let visible = skill ? message.slice(skill[0].length) || `/skill:${skill[1]}` : message;
  if (skill?.[1] === "auto-research" || message.startsWith("/skill:auto-research [Workflow:")) visible = visible.replace(RESEARCH_STARTER, "");
  return stripSubagentMentionBlock(stripQuotedMessageBlocks(visible.replace(REFERENCE_BLOCK, "")));
}

export function referencesFromMessage(message: string): Array<Pick<WorkspaceReference, "path" | "name" | "isDir" | "imageRegion">> {
  const block = message.match(/<workspace_references>([\s\S]*?)<\/workspace_references>/)?.[1];
  if (!block) return [];
  return block.split("\n").flatMap((line) => {
    if (line.startsWith(REGION_PREFIX)) {
      try {
        const decoded: unknown = JSON.parse(line.slice(REGION_PREFIX.length));
        if (!Array.isArray(decoded) || decoded.length !== 2) return [];
        const [path, description] = decoded;
        if (typeof path !== "string" || !isImageRegionPath(path) || typeof description !== "string") return [];
        return [{ path, name: pathLeaf(path), isDir: false, imageRegion: description }];
      } catch { return []; }
    }
    const match = line.match(/^\s*-\s+(file|folder):\s+("(?:[^"\\]|\\.)*")\s*$/);
    if (!match) return [];
    try {
      const path = JSON.parse(match[2]) as string;
      return [{ path, name: pathLeaf(path) || path, isDir: match[1] === "folder" }];
    } catch {
      return [];
    }
  });
}
