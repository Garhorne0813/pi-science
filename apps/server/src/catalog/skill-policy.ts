import type { SettingsData as Settings } from "../storage/settings-store.js";
import type { RuntimeSkillPolicy } from "../runtime/agent/agent-runtime-types.js";

export function storedSkillPolicy(config: Settings): RuntimeSkillPolicy {
  const policy = config.skill_policy;
  if (!policy) return { mode: "inherit" };
  if (policy.mode === "inherit" || policy.mode === "none") return { mode: policy.mode };
  return { mode: policy.mode, skills: [...new Set(policy.skills.map(String).filter(Boolean))].sort() };
}

export function skillEnabled(policy: RuntimeSkillPolicy, name: string): boolean {
  if (policy.mode === "inherit") return true;
  if (policy.mode === "none") return false;
  return policy.mode === "allowlist" ? policy.skills.includes(name) : !policy.skills.includes(name);
}

export function toggledSkillPolicy(policy: RuntimeSkillPolicy, name: string, enabled: boolean): RuntimeSkillPolicy {
  if (policy.mode === "inherit") return enabled ? policy : { mode: "denylist", skills: [name] };
  if (policy.mode === "none") return enabled ? { mode: "allowlist", skills: [name] } : policy;
  const skills = new Set(policy.skills);
  if (enabled === (policy.mode === "allowlist")) skills.add(name);
  else skills.delete(name);
  const values = [...skills].sort();
  if (policy.mode === "denylist" && values.length === 0) return { mode: "inherit" };
  return { mode: policy.mode, skills: values };
}

export function reconcileSkillPolicy(policy: RuntimeSkillPolicy, names: Set<string>): RuntimeSkillPolicy {
  if (policy.mode === "inherit" || policy.mode === "none") return policy;
  const skills = policy.skills.filter((name) => names.has(name));
  if (policy.mode === "denylist" && skills.length === 0) return { mode: "inherit" };
  return { mode: policy.mode, skills };
}
