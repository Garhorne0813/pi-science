import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configPath as globalConfigPath, readJson } from "../../../storage/persistence.js";
import type { RuntimeSkillPolicy } from "../agent-runtime-types.js";

export const SYSTEM_PROMPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../../harness/AGENTS.md");

export async function systemPrompt(): Promise<string> {
  return readFile(SYSTEM_PROMPT_PATH, "utf8");
}

export async function globalSkillPolicy(): Promise<RuntimeSkillPolicy> {
  const settings = await readJson<{ skill_policy?: RuntimeSkillPolicy }>(globalConfigPath("config.json"), {});
  const policy = settings.skill_policy;
  if (policy?.mode === "inherit" || policy?.mode === "none") return { mode: policy.mode };
  if ((policy?.mode === "allowlist" || policy?.mode === "denylist") && Array.isArray(policy.skills)) {
    return { mode: policy.mode, skills: policy.skills.filter((name): name is string => typeof name === "string") };
  }
  return { mode: "inherit" };
}

export function applySkillPolicy<T extends { name: string }>(skills: T[], policy: RuntimeSkillPolicy): T[] {
  if (policy.mode === "none") return [];
  if (policy.mode === "inherit") return skills;
  const names = new Set(policy.skills);
  return skills.filter((skill) => policy.mode === "allowlist" ? names.has(skill.name) : !names.has(skill.name));
}

/** Later skill roots override earlier ones for the same name, and the winner keeps the
 *  position its name first occupied. A seeded workspace copy therefore hides its
 *  packaged twin instead of being listed next to it. */
export function overrideByName<T extends { name: string }>(skills: T[]): T[] {
  const byName = new Map<string, T>();
  for (const skill of skills) byName.set(skill.name, skill);
  return [...byName.values()];
}
