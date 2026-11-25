import type { WorkspaceReference } from "./file-references";

export const WORKSPACE_REFERENCE_MIME = "application/x-pi-science-workspace-reference";

export function writeWorkspaceReferenceDrag(dataTransfer: DataTransfer, reference: WorkspaceReference): void {
  dataTransfer.setData(WORKSPACE_REFERENCE_MIME, JSON.stringify(reference));
  dataTransfer.setData("text/plain", `@${reference.path}`);
  dataTransfer.effectAllowed = "copyLink";
}

export function readWorkspaceReferenceDrag(dataTransfer: DataTransfer): WorkspaceReference | null {
  const raw = dataTransfer.getData(WORKSPACE_REFERENCE_MIME);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<WorkspaceReference>;
    if (typeof value.cwd !== "string" || typeof value.path !== "string" || typeof value.name !== "string" || typeof value.isDir !== "boolean") return null;
    return value as WorkspaceReference;
  } catch {
    return null;
  }
}
