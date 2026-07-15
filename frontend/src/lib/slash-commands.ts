/**
 * Slash-command definitions for the pi-science composer.
 *
 * Commands are typed as "/name" in the composer input. When the textarea
 * content starts with "/", an autocomplete menu opens. Selecting a command
 * either executes it immediately (for UI actions like /copy, /new) or
 * inserts the command with its argument hint for the user to complete.
 *
 * Dynamic commands (skills, extensions, prompt templates) are fetched
 * from the active pi session via GET /api/sessions/:id/commands.
 */

export interface SlashCommand {
  /** Command name without the leading "/". */
  name: string;
  /** Short description shown in the autocomplete menu. */
  description: string;
  /** Hint shown after the command name, e.g. "<provider/model>". */
  argumentHint?: string;
  /**
   * If true, the command is an immediate action — selecting it executes
   * the handler directly without letting the user type additional text.
   * If false, the command name + space is inserted and the user fills in args.
   */
  immediate?: boolean;
  /** Category for grouping in the menu. */
  group: "session" | "workspace" | "utility" | "skill" | "extension" | "prompt";
  /** Source label shown in autocomplete, e.g. "[skill]" or "[extension]". */
  source?: string;
}

/** Built-in slash commands. */
const BUILTIN_COMMANDS: SlashCommand[] = [
  {
    name: "new",
    description: "Start a new session",
    group: "session",
    immediate: true,
  },
  {
    name: "name",
    description: "Set session display name",
    argumentHint: "<name>",
    group: "session",
  },
  {
    name: "model",
    description: "Switch the active model",
    argumentHint: "<provider/model>",
    group: "session",
  },
  {
    name: "compact",
    description: "Manually compact the session context",
    group: "session",
    immediate: true,
  },
  {
    name: "session",
    description: "Show session info and stats",
    group: "session",
    immediate: true,
  },
  {
    name: "copy",
    description: "Copy last agent reply to clipboard",
    group: "utility",
    immediate: true,
  },
  {
    name: "export",
    description: "Export session (HTML or JSONL)",
    argumentHint: "<html|jsonl>",
    group: "utility",
  },
];

/** Dynamic commands fetched from the active pi session. */
let _dynamicCommands: SlashCommand[] = [];
let _dynamicLoaded = false;

/** Fetch skill/extension/prompt commands from an active session. */
export async function fetchDynamicCommands(sessionId: string): Promise<void> {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/commands`);
    if (!res.ok) return;
    const data = await res.json();
    const raw: Array<{
      name: string;
      description?: string;
      argumentHint?: string;
      source?: string;
    }> = data.commands ?? [];

    _dynamicCommands = raw.map((c) => {
      const source = c.source ?? "";
      let group: SlashCommand["group"] = "prompt";
      if (source === "skill") group = "skill";
      else if (source === "extension") group = "extension";

      return {
        name: c.name,
        description: c.description ?? "",
        argumentHint: c.argumentHint,
        group,
        source,
      };
    });
    _dynamicLoaded = true;
  } catch {
    _dynamicCommands = [];
  }
}

/** Reset dynamic commands (call when session changes). */
export function resetDynamicCommands(): void {
  _dynamicCommands = [];
  _dynamicLoaded = false;
}

/** All current commands (builtin + dynamic). */
export function allCommands(): SlashCommand[] {
  // Deduplicate: builtin commands take priority over dynamic ones with same name
  const builtinNames = new Set(BUILTIN_COMMANDS.map((c) => c.name));
  const filtered = _dynamicCommands.filter((c) => !builtinNames.has(c.name));
  return [...BUILTIN_COMMANDS, ...filtered];
}

/** Filter commands by a prefix string (without the leading "/"). */
export function matchCommands(prefix: string): SlashCommand[] {
  const cmds = allCommands();
  if (!prefix) return cmds;
  const lower = prefix.toLowerCase();
  return cmds.filter(
    (c) =>
      c.name.startsWith(lower) ||
      c.description.toLowerCase().includes(lower),
  );
}
