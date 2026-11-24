export type SettingsSection =
  | "general"
  | "models"
  | "agent"
  | "memory"
  | "progress"
  | "skills"
  | "capabilities"
  | "web-search"
  | "network"
  | "mcp"
  | "environments"
  | "compute";

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  "general",
  "models",
  "agent",
  "memory",
  "progress",
  "skills",
  "capabilities",
  "web-search",
  "network",
  "mcp",
  "environments",
  "compute",
];

export function isSettingsSection(value: string | null): value is SettingsSection {
  return SETTINGS_SECTIONS.includes(value as SettingsSection);
}
