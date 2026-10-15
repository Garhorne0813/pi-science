import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { parse } from "yaml";
import { discover } from "../../catalog/skill-catalog.js";
import { pathIsInside } from "../../support/platform-utils.js";
import type { RuntimeSkillPolicy } from "./agent-runtime-types.js";

export const AGENT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127})?$/;
const builtins: Record<string, string> = {
  "context-builder": "Build grounded context from workspace evidence for a later agent.",
  oracle: "Provide an independent second opinion on the supplied evidence and difficult decisions.",
  researcher: "Investigate a focused research question using the supplied evidence.",
  scout: "Explore the workspace and gather relevant context.",
  worker: "Implement the bounded delegated task using only allowed tools.",
  planner: "Plan a conservative scientific investigation. Inspect evidence and return a concrete strategy.",
  delegate: "Produce a self-contained scientific candidate following the supplied strategy and constraints.",
  reviewer: "Review scientific evidence, identify errors and limitations, and propose corrections.",
};
export interface AgentDefinition { name: string; description: string; source: "builtin" | "project" | "skill"; prompt: string; tools: string[]; path?: string }

/** One catalog for UI discovery and execution; skill namespaces never fall back to bare agents. */
export async function discoverAgentDefinitions(cwd: string, policy: RuntimeSkillPolicy = { mode: "inherit" }): Promise<AgentDefinition[]> {
  const agents = new Map<string, AgentDefinition>(Object.entries(builtins).map(([name, prompt]) => [name, { name, description: prompt, source: "builtin", prompt, tools: ["read"] }]));
  const scan = async (directory: string, boundary: string, namespace?: string) => {
    let root: string;
    try { root = await realpath(boundary); if (!pathIsInside(root, await realpath(directory), true)) return; } catch { return; }
    const visit = async (current: string): Promise<void> => {
      for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(current, entry.name);
        if (entry.isDirectory() && !namespace) { await visit(path); continue; }
        if (!entry.isFile() || !entry.name.endsWith(".md") || entry.name.endsWith(".chain.md") || entry.name === "README.md") continue;
        if (!pathIsInside(root, await realpath(path)) || (await stat(path)).size > 512 * 1024) continue;
        const text = (await readFile(path, "utf8")).replaceAll("\r\n", "\n");
        const front = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
        let meta; try { meta = front ? parse(front[1]!) : {}; } catch { continue; /* malformed definitions do not disable the catalog */ }
        if (!meta || typeof meta !== "object" || Array.isArray(meta)) continue;
        const local = namespace ? entry.name.slice(0, -3) : String(meta.name ?? entry.name.slice(0, -3));
        const name = namespace ? `${namespace}/${local}` : meta.package ? `${meta.package}.${local}` : local;
        if (!AGENT_NAME_PATTERN.test(name) || !namespace && name.includes("/")) continue;
        const tools = Array.isArray(meta.tools) ? meta.tools : typeof meta.tools === "string" ? meta.tools.split(",").map((v: string) => v.trim()) : ["read"];
        if (!tools.every((v: unknown) => typeof v === "string")) continue;
        agents.set(name, { name, description: String(meta.description ?? ""), source: namespace ? "skill" : "project", prompt: front ? text.slice(front[0].length) : text, tools, path: relative(cwd, path).replaceAll("\\", "/") });
      }
    };
    try { await visit(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  await scan(join(cwd, ".pi", "agents"), cwd);
  if (policy.mode !== "none") for (const skill of await discover(cwd)) {
    if (!skill.validation.valid) continue;
    const boundary = await realpath(skill.source === "project" ? cwd : skill.sourceRoot);
    if (!pathIsInside(boundary, await realpath(skill.sourcePath))) continue;
    if (policy.mode === "allowlist" && !policy.skills.includes(skill.metadata.name) || policy.mode === "denylist" && policy.skills.includes(skill.metadata.name)) continue;
    await scan(join(dirname(skill.sourcePath), "agents"), skill.source === "project" ? cwd : skill.sourceRoot, skill.metadata.name);
  }
  return [...agents.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export async function resolveAgentDefinition(cwd: string, name: string, policy?: RuntimeSkillPolicy): Promise<AgentDefinition> {
  if (!AGENT_NAME_PATTERN.test(name)) throw new Error(`Invalid agent name: ${name}`);
  const definitions = await discoverAgentDefinitions(cwd, policy);
  const definition = definitions.find((agent) => agent.name === name && agent.source !== "builtin")
    ?? definitions.find((agent) => !name.includes("/") && agent.source === "project" && agent.path === `.pi/agents/${name}.md`)
    ?? definitions.find((agent) => agent.name === name);
  if (!definition) throw new Error(`Unknown or disabled agent: ${name}`);
  return definition;
}
export function childToolAllowance(tools: string[], parent?: string[]): string[] {
  return tools.filter((name) => (!parent || parent.includes(name)) && name !== "ask_user_question" && !name.startsWith("mcp_"));
}
