import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { cn } from "../lib/ui";
import { getDynamicCommandsSnapshot, matchCommands, subscribeDynamicCommands } from "../lib/conversation";
import { useUiStore } from "../lib/ui";

interface Props {
  input: string;
  onSelect: (value: string) => void;
  onDismiss?: () => void;
}

export function SlashCommandMenu({ input, onSelect, onDismiss }: Props) {
  const prefix = input.startsWith("/") && !input.includes(" ") ? input.slice(1) : null;
  const dynamicCommands = useSyncExternalStore(
    subscribeDynamicCommands,
    getDynamicCommandsSnapshot,
    getDynamicCommandsSnapshot,
  );
  const [dismissedInput, setDismissedInput] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuDismissed = dismissedInput === input;
  const commands = useMemo(
    () => (prefix === null || menuDismissed ? [] : matchCommands(prefix, dynamicCommands)),
    [prefix, dynamicCommands, menuDismissed],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const commandRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (dismissedInput !== null && dismissedInput !== input) setDismissedInput(null);
  }, [dismissedInput, input]);

  const dismissMenu = useCallback(() => {
    setDismissedInput(input);
    onDismiss?.();
  }, [input, onDismiss]);

  useEffect(() => {
    if (commands.length === 0) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !menuRef.current?.contains(target)) dismissMenu();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [commands.length, dismissMenu]);

  useEffect(() => setActiveIndex(0), [commands.length]);

  useEffect(() => {
    const activeCommand = commandRefs.current[activeIndex];
    if (activeCommand && typeof activeCommand.scrollIntoView === "function") {
      activeCommand.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);

  useEffect(() => {
    if (commands.length === 0) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      // The settings modal overlays the composer; never swallow its keys.
      if (useUiStore.getState().settingsOpen) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismissMenu();
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
  }, [activeIndex, commands, dismissMenu, onSelect]);

  if (commands.length === 0) return null;

  return (
    <div ref={menuRef} role="listbox" className="ui-popover absolute bottom-full left-0 right-0 z-50 mb-1 max-h-56 w-full max-w-full overflow-y-auto rounded-card p-1">
      {commands.map((command, index) => (
        <button
          key={`${command.source || "builtin"}-${command.name}`}
          ref={(element) => { commandRefs.current[index] = element; }}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(command.argumentHint ? `/${command.name} ` : `/${command.name}`)}
          className={cn(
            "flex min-w-0 w-full items-center gap-2 rounded-input px-2 py-1.5 text-left text-xs",
            index === activeIndex ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2",
          )}
        >
          <span className="max-w-[55%] min-w-0 shrink-0 truncate rounded bg-surface-2 px-1 font-mono text-accent sm:max-w-none" title={`/${command.name}`}>/{command.name}</span>
          {command.source && <span className="shrink-0 rounded bg-accent/10 px-1 text-[10px] text-accent">{command.source}</span>}
          <span className="min-w-0 flex-1 truncate" title={command.description}>{command.description}</span>
          {command.argumentHint && <span className="shrink-0 font-mono text-[10px] text-muted/60">{command.argumentHint}</span>}
        </button>
      ))}
    </div>
  );
}
