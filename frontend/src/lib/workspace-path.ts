export function pathLeaf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() ?? "";
}

export function workspacePathLeaf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed || /^[A-Za-z]:$/.test(trimmed) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+$/.test(trimmed)) return "";
  return pathLeaf(trimmed);
}
