import { useEffect, useRef, useState, useCallback } from "react";
import { matchCommands, type SlashCommand } from "@/lib/slash-commands";
import { cn } from "@/lib/cn";

interface Props {
  /** The current input value in the composer. */
  input: string;
  /** Called when a command is selected. Receives the full text to insert. */
  onSelect: (text: string) => void;
  /** Called when the user wants to dismiss (Escape). */
  onDismiss: () => void;
  /** Position the menu above the textarea anchor. */
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function SlashCommandMenu({ input, onSelect, onDismiss, anchorRef }: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  // Extract the prefix after the last "/"
  const prefix = extractPrefix(input);
  const commands = matchCommands(prefix);

  // Reset active index when commands change
  useEffect(() => {
    setActiveIndex(0);
  }, [commands.length]);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, Math.max(0, commands.length - 1)));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && commands.length > 0) {
        e.preventDefault();
        const cmd = commands[Math.min(activeIndex, commands.length - 1)];
        if (cmd) applyCommand(cmd, onSelect);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    },
    [commands, activeIndex, onSelect, onDismiss],
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown, true); // capture phase
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleKeyDown]);

  if (commands.length === 0) return null;

  return (
    <div
      ref={menuRef}
      className="absolute bottom-full left-0 mb-1 w-72 max-h-56 overflow-y-auto rounded-card border border-border bg-surface shadow-card z-50"
    >
      <CommandList commands={commands} activeIndex={activeIndex} onPick={(cmd) => applyCommand(cmd, onSelect)} />
    </div>
  );
}

/** Group commands and render the list. */
function CommandList({
  commands,
  activeIndex,
  onPick,
}: {
  commands: SlashCommand[];
  activeIndex: number;
  onPick: (cmd: SlashCommand) => void;
}) {
  const groups = new Map<string, SlashCommand[]>();
  for (const c of commands) {
    const list = groups.get(c.group) || [];
    list.push(c);
    groups.set(c.group, list);
  }

  const groupLabels: Record<string, string> = {
    session: "Session",
    workspace: "Workspace",
    utility: "Utility",
    skill: "Skills",
    extension: "Extensions",
    prompt: "Prompts",
  };

  let idx = 0;
  const items: React.ReactNode[] = [];
  for (const [group, cmds] of groups) {
    items.push(
      <div key={`g-${group}`} className="px-3 pt-2 pb-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">
        {groupLabels[group] || group}
      </div>,
    );
    for (const cmd of cmds) {
      const i = idx;
      items.push(
        <button
          key={cmd.name}
          onClick={() => onPick(cmd)}
          className={cn(
            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-2",
            i === activeIndex && "bg-surface-2 text-text",
            i !== activeIndex && "text-text",
          )}
        >
          <span className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs text-accent">/{cmd.name}</span>
          {cmd.source && (
            <span className="shrink-0 rounded bg-accent/10 px-1 text-[10px] text-accent">{cmd.source}</span>
          )}
          <span className="flex-1 truncate text-muted">{cmd.description}</span>
          {cmd.argumentHint && (
            <span className="shrink-0 font-mono text-[11px] text-muted/60">{cmd.argumentHint}</span>
          )}
        </button>,
      );
      idx++;
    }
  }

  return <>{items}</>;
}

// ── Helpers ──

/** Extract the text after the last "/" in the input. Returns "" if input
 *  doesn't start with "/" or has already completed a command (space after it). */
function extractPrefix(input: string): string {
  if (!input.startsWith("/")) return "";
  // If there's a space, the user has already typed the command name — show
  // matching commands for the word after "/"
  const firstSpace = input.indexOf(" ");
  if (firstSpace !== -1) return "";
  return input.slice(1);
}

/** Insert command text into the composer or execute immediate commands. */
function applyCommand(cmd: SlashCommand, onSelect: (text: string) => void) {
  if (cmd.immediate && !cmd.argumentHint) {
    // Immediate commands: use a special marker that the parent can detect
    onSelect(`/${cmd.name}`);
  } else if (cmd.argumentHint) {
    // Insert command name and let user type args
    onSelect(`/${cmd.name} `);
  } else {
    onSelect(`/${cmd.name}`);
  }
}
