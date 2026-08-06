import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Auto-expands a todo widget once per "todo streak" when the conversation
 * first shows visible todo tasks (or is restored with an existing list).
 * Semantics:
 * - fires once per streak key (workspace:session): after the widget has been
 *   opened (automatically or by the user) it does not re-open until the list
 *   fully disappears;
 * - a user close is respected for the rest of that streak;
 * - switching sessions resets the streak via the key.
 */
export function useTodoAutoOpenOnce(todoVisible: boolean, streakKey: string): { open: boolean; setOpen: (open: boolean) => void; close: () => void } {
  const [open, setOpen] = useState(false);
  const streakRef = useRef<{ key: string; opened: boolean } | null>(null);

  useEffect(() => {
    if (!todoVisible) {
      setOpen(false);
      streakRef.current = null;
      return;
    }
    if (!streakRef.current || streakRef.current.key !== streakKey) {
      streakRef.current = { key: streakKey, opened: false };
    }
    if (!streakRef.current.opened) {
      streakRef.current.opened = true;
      setOpen(true);
    }
  }, [todoVisible, streakKey]);

  const setOpenManual = useCallback((next: boolean) => {
    if (next) {
      // A manual open still counts as "opened this streak" so an auto-open
      // does not fight the user later.
      if (streakRef.current) streakRef.current.opened = true;
      setOpen(true);
    } else {
      setOpen(false);
    }
  }, []);

  const close = useCallback(() => {
    if (streakRef.current) streakRef.current.opened = true;
    setOpen(false);
  }, []);

  return { open, setOpen: setOpenManual, close };
}
