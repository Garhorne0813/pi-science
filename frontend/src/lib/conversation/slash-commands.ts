import { apiRequest } from "../client/api";

export interface SlashArgumentSpec {
  name: string;
  required?: boolean;
  values?: string[];
  placeholder?: string;
}

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  arguments?: SlashArgumentSpec[];
  immediate?: boolean;
  group: "session" | "utility" | "skill";
  source?: string;
}

const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "compact", description: "Compact the current session", group: "session", immediate: true },
  {
    name: "export",
    description: "Export the session",
    argumentHint: "<html|jsonl>",
    arguments: [{ name: "format", required: false, values: ["html", "jsonl"], placeholder: "html|jsonl" }],
    group: "utility",
  },
];

/** Each runtime owns its command catalogue. Late responses update only their own query. */
export const slashCommandsQuery = (cwd: string, sessionId: string | null) => ({
  queryKey: ["slash-commands", cwd, sessionId],
  enabled: Boolean(sessionId),
  staleTime: 0,
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<SlashCommand[]> => {
    const data = await apiRequest<{ commands?: SlashCommand[] }>(
      `/api/sessions/${encodeURIComponent(sessionId!)}/commands?${new URLSearchParams({ cwd })}`,
      { signal },
    );
    return (Array.isArray(data.commands) ? data.commands : [])
      .filter((command: SlashCommand) => command.source === "skill" && command.name.startsWith("skill:"))
      .map((command: SlashCommand) => ({
        name: command.name,
        description: command.description || "",
        argumentHint: command.argumentHint,
        arguments: command.arguments,
        source: command.source,
        group: "skill" as const,
      }));
  },
});

export function allCommands(commands: readonly SlashCommand[] = []): SlashCommand[] {
  const builtins = new Set(BUILTIN_COMMANDS.map((command) => command.name));
  return [...BUILTIN_COMMANDS, ...commands.filter((command) => !builtins.has(command.name))];
}

export function commandTakesArguments(command: SlashCommand): boolean {
  return Boolean(command.argumentHint) || (command.arguments?.length ?? 0) > 0;
}

/** The hint a candidate row shows: the server-sent display text for a skill command, otherwise
 *  the declared values rendered per argument. */
export function commandHint(command: SlashCommand): string | undefined {
  if (command.argumentHint) return command.argumentHint;
  if (!command.arguments?.length) return undefined;
  return command.arguments.map((argument) => `<${(argument.values ?? []).join("|")}>`).join(" ");
}

function commandRank(command: SlashCommand, value: string): number | null {
  if (!value) return 0;
  const name = command.name.toLowerCase();
  if (name.startsWith(value)) return 0;
  if (name.includes(value)) return 1;
  if (command.description.toLowerCase().includes(value)) return 2;
  return null;
}

export function matchCommands(prefix: string, commands: readonly SlashCommand[] = []): SlashCommand[] {
  const value = prefix.toLowerCase();
  return allCommands(commands)
    .map((command) => ({ command, rank: commandRank(command, value) }))
    .filter((entry): entry is { command: SlashCommand; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.command);
}
