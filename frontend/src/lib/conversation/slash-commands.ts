import { ApiError, apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  immediate?: boolean;
  group: "session" | "workspace" | "utility" | "skill" | "extension" | "prompt";
  source?: string;
}

const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "new", description: "Start a new session", group: "session", immediate: true },
  { name: "name", description: "Set session display name", argumentHint: "<name>", group: "session" },
  { name: "model", description: "Switch the active model", argumentHint: "<provider/model>", group: "session" },
  { name: "compact", description: "Compact the current session", group: "session", immediate: true },
  { name: "session", description: "Show session information", group: "session", immediate: true },
  { name: "copy", description: "Copy the last agent reply", group: "utility", immediate: true },
  { name: "export", description: "Export the session", argumentHint: "<html|jsonl>", group: "utility" },
];

let dynamicCommands: SlashCommand[] = [];

export async function fetchDynamicCommands(sessionId: string, cwd: string): Promise<void> {
  try {
    const data = await queryClient.fetchQuery({
      queryKey: ["slash-commands", cwd, sessionId],
      queryFn: () => apiRequest<{ commands?: SlashCommand[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/commands?${new URLSearchParams({ cwd })}`),
      staleTime: 0,
    });
    dynamicCommands = (Array.isArray(data.commands) ? data.commands : []).map((command: SlashCommand) => ({
      name: command.name,
      description: command.description || "",
      argumentHint: command.argumentHint,
      source: command.source,
      group: command.source === "skill" ? "skill" : command.source === "extension" ? "extension" : "prompt",
    }));
  } catch (error) {
    // An HTTP error means the session has no command list to offer yet — keep the
    // ones already loaded, as the pre-Query code did by returning on `!response.ok`.
    if (!(error instanceof ApiError)) dynamicCommands = [];
  }
}

export function resetDynamicCommands(): void {
  dynamicCommands = [];
}

export function allCommands(): SlashCommand[] {
  const builtins = new Set(BUILTIN_COMMANDS.map((command) => command.name));
  return [...BUILTIN_COMMANDS, ...dynamicCommands.filter((command) => !builtins.has(command.name))];
}

export function matchCommands(prefix: string): SlashCommand[] {
  const value = prefix.toLowerCase();
  return allCommands().filter((command) => (
    !value
    || command.name.toLowerCase().startsWith(value)
    || command.description.toLowerCase().includes(value)
  ));
}
