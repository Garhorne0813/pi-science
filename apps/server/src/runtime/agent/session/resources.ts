import type { PiConfig } from "@pi-science/contracts";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT, NodeExecutionEnv, loadPromptTemplates, loadSkills } from "@earendil-works/pi-agent-core/node";
import type { RuntimeSkillPolicy } from "../agent-runtime-types.js";
import { packagedSkillsRoot } from "../runtime-config.js";
import { CredentialStore } from "../../../model-resources/credential-store.js";
import { projectedEnvironmentNames } from "../../shared/extensions/pi-science-mcp.js";
import { globalSkillPolicy, applySkillPolicy, overrideByName } from "./resource-policy.js";
import type { SessionContext } from "./context.js";

type Context = Pick<SessionContext, "environments" | "live" | "server">;

export async function workerEnvironment(context: Context, cwd: string): Promise<Record<string, string>> {
  const environment = await context.environments.environment(cwd);
  return {
    ...environment,
    ...(context.server.backendUrl ? { PI_SCIENCE_BACKEND_URL: context.server.backendUrl } : {}),
    ...(context.server.internalToken ? { PI_SCIENCE_INTERNAL_TOKEN: context.server.internalToken } : {}),
  } as Record<string, string>;
}

export async function composerCommands(_context: Context, cwd: string, config: PiConfig): Promise<{ commands: Array<{ name: string; description: string; source: string; group: string }>; revision: string }> {
  const executionEnv = new NodeExecutionEnv({ cwd, shellEnv: {} });
  const skillPaths = [packagedSkillsRoot(), join(cwd, ".pi", "skills"), ...(config.skills ?? [])];
  const [discovered, templates, policy] = await Promise.all([
    loadSkills(executionEnv, skillPaths, BACKGROUND_CONTEXT),
    loadPromptTemplates(executionEnv, join(cwd, ".pi", "prompts"), BACKGROUND_CONTEXT),
    globalSkillPolicy(),
  ]);
  const commands = [
    ...applySkillPolicy(overrideByName(discovered.skills), policy).map((skill) => ({ name: `skill:${skill.name}`, description: skill.description, source: "skill", group: "skill" })),
    ...templates.promptTemplates.map((template) => ({ name: template.name, description: template.description ?? "", source: "prompt", group: "utility" })),
  ];
  const revision = createHash("sha256").update(JSON.stringify({ commands, policy })).digest("hex").slice(0, 16);
  return { commands, revision };
}

export async function credentialEnvNames(_context: Context, cwd: string): Promise<string[]> {
  const metadata = await new CredentialStore().listMetadata();
  return [...new Set([
    ...metadata.filter((item) => item.backend === "environment").map((item) => item.environment_variable).filter((name): name is string => Boolean(name)),
    ...projectedEnvironmentNames(cwd),
  ])];
}

export async function setGlobalSkillPolicy(context: Context, policy: RuntimeSkillPolicy): Promise<void> {
  for (const item of context.live.values()) {
    const result = await item.runtime.setSkillPolicy(policy);
    if (!result.success) throw new Error(String(result.error ?? "unable to update agent skills"));
  }
}

export async function refreshAllSkills(context: Context): Promise<void> {
  for (const item of context.live.values()) {
    const result = await item.runtime.refreshSkills();
    if (!result.success) throw new Error(String(result.error ?? "unable to refresh agent skills"));
  }
}
