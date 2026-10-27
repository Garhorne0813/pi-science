import { catalog as skillCatalog } from "./skill-catalog.js";

export async function unifiedSkillCatalog(workspaces: string[]) {
  const catalogs = await Promise.all([process.cwd(), ...workspaces].map((cwd) => skillCatalog(cwd)));
  const byName = new Map<string, Awaited<ReturnType<typeof skillCatalog>>[number]>();
  for (const catalog of catalogs) for (const skill of catalog) if (!byName.has(skill.name)) byName.set(skill.name, skill);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
