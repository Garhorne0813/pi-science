import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export type PromptConfiguration =
  | { mode: "interactive"; role?: string }
  | { mode: "isolated"; system: string };
export const PROMPT_VERSION = "2";
const CORE_PATH = fileURLToPath(new URL("../../../../../../harness/SYSTEM.md", import.meta.url));
const MAIN_PATH = fileURLToPath(
  new URL("../../../../../../harness/roles/main.md", import.meta.url),
);

/** Snapshot application rules once per Worker. Project context is refreshed separately. */
export async function loadPrompt(configuration: PromptConfiguration = { mode: "interactive" }) {
  if (configuration.mode === "isolated")
    return { mode: configuration.mode, base: configuration.system, version: "isolated" };
  const [core, role] = await Promise.all([
    readFile(CORE_PATH, "utf8"),
    configuration.role !== undefined ? configuration.role : readFile(MAIN_PATH, "utf8"),
  ]);
  return {
    mode: configuration.mode,
    base: [core.trim(), role.trim()].filter(Boolean).join("\n\n"),
    version: PROMPT_VERSION,
  };
}
