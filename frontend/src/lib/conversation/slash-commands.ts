import { ApiError, apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  immediate?: boolean;
  group: "session" | "utility" | "skill";
  source?: string;
}

const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "compact", description: "Compact the current session", group: "session", immediate: true },
  { name: "export", description: "Export the session", argumentHint: "<html|jsonl>", group: "utility" },
];

let dynamicCommands: SlashCommand[] = [];
const dynamicCommandListeners = new Set<() => void>();

function notifyDynamicCommands(): void {
  dynamicCommandListeners.forEach((listener) => listener());
}

export function subscribeDynamicCommands(listener: () => void): () => void {
  dynamicCommandListeners.add(listener);
  return () => dynamicCommandListeners.delete(listener);
}

export function getDynamicCommandsSnapshot(): SlashCommand[] {
  return dynamicCommands;
}

export async function fetchDynamicCommands(sessionId: string, cwd: string): Promise<void> {
  try {
    const data = await queryClient.fetchQuery({
      queryKey: ["slash-commands", cwd, sessionId],
      queryFn: () => apiRequest<{ commands?: SlashCommand[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/commands?${new URLSearchParams({ cwd })}`),
      staleTime: 0,
    });
    dynamicCommands = (Array.isArray(data.commands) ? data.commands : [])
      .filter((command: SlashCommand) => command.source === "skill" && command.name.startsWith("skill:"))
      .map((command: SlashCommand) => ({
        name: command.name,
        description: command.description || "",
        argumentHint: command.argumentHint,
        source: command.source,
        group: "skill" as const,
      }));
    notifyDynamicCommands();
  } catch (error) {
    // An HTTP error means the session has no command list to offer yet — keep the
    // ones already loaded, as the pre-Query code did by returning on `!response.ok`.
    if (!(error instanceof ApiError)) {
      dynamicCommands = [];
      notifyDynamicCommands();
    }
  }
}

export function resetDynamicCommands(): void {
  dynamicCommands = [];
  notifyDynamicCommands();
}

export function allCommands(commands = dynamicCommands): SlashCommand[] {
  const builtins = new Set(BUILTIN_COMMANDS.map((command) => command.name));
  return [...BUILTIN_COMMANDS, ...commands.filter((command) => !builtins.has(command.name))];
}

export function matchCommands(prefix: string, commands = dynamicCommands): SlashCommand[] {
  const value = prefix.toLowerCase();
  return allCommands(commands).filter((command) => (
    !value
    || command.name.toLowerCase().startsWith(value)
    || command.description.toLowerCase().includes(value)
  ));
}
