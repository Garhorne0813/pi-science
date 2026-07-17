import type { RunRecord } from "../types/thread";

export async function loadRuns(sessionId: string, cwd = "."): Promise<RunRecord[]> {
  const runs = await listRuns(cwd);
  return runs.filter((run) => run.sessionId === sessionId);
}

export async function listRuns(cwd: string): Promise<RunRecord[]> {
  try {
    const params = new URLSearchParams({ cwd });
    const response = await fetch(`/api/runs?${params}`);
    if (!response.ok) return [];
    const data: unknown = await response.json();
    return Array.isArray(data) ? (data as RunRecord[]) : [];
  } catch {
    return [];
  }
}

export function reproduceRunPrompt(run: RunRecord): string {
  const command = run.command ? `\n\nRecorded command:\n\`\`\`sh\n${run.command}\n\`\`\`` : "";
  return (
    `Reproduce experiment run \`${run.runId}\`. Re-run it in the current workspace, ` +
    `compare all recorded outputs with the current files, and summarize any differences.${command}`
  );
}
