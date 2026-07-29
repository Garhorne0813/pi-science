export function workspacePathLeaf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed || /^[A-Za-z]:$/.test(trimmed)) return "";
  return trimmed.split(/[\\/]/).pop() ?? "";
}
