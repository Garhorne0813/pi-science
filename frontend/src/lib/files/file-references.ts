import { pathLeaf } from "../workspace";
import { stripSubagentMentionBlock } from "../conversation/subagent-mentions";

export interface WorkspaceReference {
  cwd: string;
  path: string;
  name: string;
  isDir: boolean;
}

const REFERENCE_BLOCK = /<workspace_references>[\s\S]*?<\/workspace_references>\s*/g;

export function injectWorkspaceReferences(message: string, references: WorkspaceReference[]): string {
  if (references.length === 0) return message;
  const items = references
    .map((reference) => `- ${reference.isDir ? "folder" : "file"}: ${JSON.stringify(reference.path)}`)
    .join("\n");
  return `${message}\n\n<workspace_references>\n${items}\n</workspace_references>`.trim();
}

export function visibleUserMessage(message: string): string {
  return stripSubagentMentionBlock(message.replace(REFERENCE_BLOCK, ""));
}

export function referencesFromMessage(message: string): Array<Pick<WorkspaceReference, "path" | "name" | "isDir">> {
  const block = message.match(/<workspace_references>([\s\S]*?)<\/workspace_references>/)?.[1];
  if (!block) return [];
  return block.split("\n").flatMap((line) => {
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
