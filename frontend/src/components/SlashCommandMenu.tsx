import { useEffect, useMemo, useState } from "react";
import { cn } from "../lib/cn";
import { matchCommands } from "../lib/slash-commands";

interface Props {
  input: string;
  onSelect: (value: string) => void;
  onDismiss: () => void;
}

export function SlashCommandMenu({ input, onSelect, onDismiss }: Props) {
  const prefix = input.startsWith("/") && !input.includes(" ") ? input.slice(1) : null;
  const commands = useMemo(() => (prefix === null ? [] : matchCommands(prefix)), [prefix]);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => setActiveIndex(0), [commands.length]);

  useEffect(() => {
    if (commands.length === 0) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((index) => Math.min(index + 1, commands.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((index) => Math.max(index - 1, 0));
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        const command = commands[activeIndex];
        if (command) onSelect(command.argumentHint ? `/${command.name} ` : `/${command.name}`);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeIndex, commands, onDismiss, onSelect]);

  if (commands.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 z-50 mb-1 max-h-56 w-80 overflow-y-auto rounded-card border border-border bg-surface shadow-card">
      {commands.map((command, index) => (
        <button
          key={`${command.source || "builtin"}-${command.name}`}
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(command.argumentHint ? `/${command.name} ` : `/${command.name}`)}
          className={cn(
            "flex w-full items-center gap-2 px-3 py-2 text-left text-xs",
            index === activeIndex ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2",
          )}
        >
          <span className="rounded bg-surface-2 px-1 font-mono text-accent">/{command.name}</span>
          {command.source && <span className="rounded bg-accent/10 px-1 text-[10px] text-accent">{command.source}</span>}
          <span className="min-w-0 flex-1 truncate">{command.description}</span>
          {command.argumentHint && <span className="font-mono text-[10px] text-muted/60">{command.argumentHint}</span>}
        </button>
      ))}
    </div>
  );
}
