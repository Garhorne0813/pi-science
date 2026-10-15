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
  requiresSession?: boolean;
}

const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "compact", description: "Compact the current session", group: "session", immediate: true, requiresSession: true },
  {
    name: "export",
    description: "Export the session",
    argumentHint: "<html|jsonl>",
    arguments: [{ name: "format", required: false, values: ["html", "jsonl"], placeholder: "html|jsonl" }],
    group: "utility",
    requiresSession: true,
  },
];

/** Every catalogue of every workspace. A global skill policy write leaves all of them stale. */
export const slashCommandsRoot = ["composer-commands"];

/** Every catalogue of one workspace: the blank composer's read-only one and every session's. A
 *  policy write invalidates this prefix, so the key can never drift from what it invalidates. */
export const slashCommandsPrefix = (cwd: string) => [...slashCommandsRoot, cwd];

/** The catalogue one composer reads. A blank composer has no session and reads the workspace
 *  catalogue; an active session keeps its own runtime policy. */
export const slashCommandsKey = (cwd: string, sessionId: string | null = null) => [...slashCommandsPrefix(cwd), sessionId];

/** A blank composer uses the read-only workspace catalog; an existing session keeps its runtime policy. */
export const slashCommandsQuery = (cwd: string, sessionId: string | null = null) => ({
  queryKey: slashCommandsKey(cwd, sessionId),
  enabled: Boolean(cwd),
  staleTime: 15_000,
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<SlashCommand[]> => {
    const endpoint = sessionId
      ? `/api/sessions/${encodeURIComponent(sessionId)}/commands?${new URLSearchParams({ cwd })}`
      : `/api/composer/commands?${new URLSearchParams({ cwd })}`;
    const data = await apiRequest<{ commands?: SlashCommand[]; revision?: string }>(
      endpoint,
      { signal },
    );
    return (Array.isArray(data.commands) ? data.commands : [])
      .filter((command: SlashCommand) => (
        command.source === "prompt"
        || (command.source === "skill" && command.name.startsWith("skill:"))
      ))
      .map((command: SlashCommand): SlashCommand => ({
        name: command.name,
        description: command.description || "",
        argumentHint: command.argumentHint,
        arguments: command.arguments,
        source: command.source,
        group: command.source === "prompt" ? "utility" as const : "skill" as const,
        requiresSession: command.requiresSession ?? false,
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

