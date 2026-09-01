import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AutoResearchSnapshot, ResearchNode } from "@pi-science/contracts";

export const researchReportPath = (researchId: string) => `research-reports/${researchId}.md`;

/** Materialize the durable research graph as a user-visible Markdown report. */
export async function writeResearchReport(
  cwd: string,
  snapshot: AutoResearchSnapshot,
  reason: string,
  completedAt: string,
): Promise<string> {
  const relativePath = researchReportPath(snapshot.research_id);
  const directory = join(cwd, "research-reports");
  await mkdir(directory, { recursive: true });
  await writeFile(join(cwd, relativePath), renderResearchReport(snapshot, reason, completedAt), "utf8");
  return relativePath;
}

export function renderResearchReport(snapshot: AutoResearchSnapshot, reason: string, completedAt: string): string {
  const synthesis = snapshot.nodes.findLast((node) => node.kind === "synthesis" && node.status === "succeeded");
  const summary = synthesis?.kind === "synthesis" && synthesis.summary.trim()
    ? synthesis.summary.trim()
    : "The research completed without a synthesis summary.";
  const lines = [
    `# ${inline(snapshot.title)}`,
    "",
    `> Auto Research report · ${snapshot.research_id}`,
    "",
    "## Executive summary",
    "",
    summary,
    "",
    "## Research brief",
    "",
    `- **Objective:** ${inline(snapshot.objective)}`,
    `- **Status:** Completed`,
    `- **Stop reason:** ${inline(reason)}`,
    `- **Started:** ${snapshot.started_at ?? "Not recorded"}`,
    `- **Completed:** ${completedAt}`,
    `- **Experiments:** ${snapshot.usage.experiments_completed}/${snapshot.usage.experiments_started} completed`,
    `- **Model tokens:** ${snapshot.usage.model_tokens}`,
    `- **Cost:** $${snapshot.usage.cost_usd.toFixed(4)}`,
    "",
    "## Constraints",
    "",
    ...(snapshot.constraints.length ? snapshot.constraints.map((item) => `- ${inline(item)}`) : ["No explicit constraints were recorded."]),
    "",
    "## Best result",
    "",
    ...(snapshot.best_result ? jsonBlock(snapshot.best_result) : ["No successful experiment result was recorded."]),
    "",
    "## Claims",
    "",
    ...(snapshot.claims.length
      ? snapshot.claims.map((claim) => `- **${Math.round(claim.confidence * 100)}% confidence · ${claim.status}:** ${inline(claim.statement)}${claim.scope ? ` _(scope: ${inline(claim.scope)})_` : ""}`)
      : ["No claims were recorded."]),
    "",
    "## Evidence",
    "",
    ...(snapshot.evidence.length
      ? snapshot.evidence.map((evidence) => `- **${evidence.kind}** \`${evidence.evidence_id}\`: ${evidenceSummary(evidence.locator)}`)
      : ["No evidence records were captured."]),
    "",
    "## Research process",
    "",
    ...snapshot.nodes.flatMap(renderNode),
    "",
    "## Experiment outputs",
    "",
    ...experimentOutputs(snapshot.nodes),
    "",
    "---",
    "",
    "Generated automatically by Pi Science Auto Research.",
    "",
  ];
  return lines.join("\n");
}

function renderNode(node: ResearchNode): string[] {
  const body = node.kind === "question" ? node.question
    : node.kind === "hypothesis" ? node.statement
      : node.kind === "literature" ? node.question
        : node.kind === "experiment" ? node.spec.objective
          : node.kind === "analysis" ? `Analysis of ${node.target_node_ids.join(", ") || "research findings"}`
            : node.kind === "verification" ? `Verification of ${node.target_node_id}`
              : node.kind === "decision" ? `${node.reason}${node.resolution ? ` Resolution: ${node.resolution}` : ""}`
                : node.summary || "Synthesis";
  return [`### ${titleCase(node.kind)} · ${node.status}`, "", `${inline(body)}`, ""];
}

function experimentOutputs(nodes: ResearchNode[]): string[] {
  const outputs = nodes.flatMap((node) => {
    if (node.kind !== "experiment" || !node.result || typeof node.result !== "object") return [];
    const result = node.result as Record<string, unknown>;
    const path = typeof result.outputs_dir === "string" ? result.outputs_dir : null;
    const job = typeof result.job_id === "string" ? result.job_id : node.execution_id;
    if (!path && !job) return [];
    return [`- **${node.node_id}**${path ? ` — \`${path}\`` : ""}${job ? ` (job \`${job}\`)` : ""}`];
  });
  return outputs.length ? outputs : ["No experiment output directories were recorded."];
}

function evidenceSummary(locator: Record<string, unknown>): string {
  if (typeof locator.summary === "string" && locator.summary.trim()) return inline(locator.summary);
  if (locator.metrics && typeof locator.metrics === "object") return `metrics ${inline(JSON.stringify(locator.metrics))}`;
  if (typeof locator.outputs_dir === "string") return `outputs at \`${locator.outputs_dir}\``;
  return inline(JSON.stringify(locator));
}

function jsonBlock(value: unknown): string[] {
  return ["```json", JSON.stringify(value, null, 2), "```"];
}

function inline(value: string): string {
  return value.replace(/\s+/g, " ").trim().replaceAll("|", "\\|");
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
