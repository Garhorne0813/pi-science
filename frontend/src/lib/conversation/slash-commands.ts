import { ApiError, apiRequest } from "../client/api";
import { queryClient } from "../client/query-client";

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

let dynamicCommands: SlashCommand[] = [];
let dynamicCommandsCwd: string | null = null;
const NO_DYNAMIC_COMMANDS: SlashCommand[] = [];
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

/** Commands discovered for `cwd`, or none while the cache belongs to another workspace. */
export function dynamicCommandsFor(cwd: string): SlashCommand[] {
  return dynamicCommandsCwd === cwd ? dynamicCommands : NO_DYNAMIC_COMMANDS;
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
    dynamicCommandsCwd = cwd;
    notifyDynamicCommands();
  } catch (error) {
    // An HTTP error means the session has no command list to offer yet — keep the
    // ones already loaded, as the pre-Query code did by returning on `!response.ok`.
    if (!(error instanceof ApiError)) {
      dynamicCommands = [];
      dynamicCommandsCwd = cwd;
      notifyDynamicCommands();
    }
  }
}

/** Drop the cached commands unless they were discovered for `cwd`. Starting a new conversation in
 *  the same workspace keeps them; switching workspaces does not. */
export function retainDynamicCommands(cwd: string): void {
  if (dynamicCommandsCwd === cwd) return;
  resetDynamicCommands();
}

export function resetDynamicCommands(): void {
  dynamicCommands = [];
  dynamicCommandsCwd = null;
  notifyDynamicCommands();
}

export function allCommands(commands: readonly SlashCommand[] = dynamicCommands): SlashCommand[] {
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

export function matchCommands(prefix: string, commands: readonly SlashCommand[] = dynamicCommands): SlashCommand[] {
  const value = prefix.toLowerCase();
  return allCommands(commands)
    .map((command) => ({ command, rank: commandRank(command, value) }))
    .filter((entry): entry is { command: SlashCommand; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.command);
}
