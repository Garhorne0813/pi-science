import { useCallback, useEffect, useRef } from "react";
import { useUiStore } from "@/lib/ui";

/**
 * Auto-expands a todo widget once per "todo streak" when new tasks appear in
 * an already-loaded conversation. A list restored with an existing session is
 * kept collapsed so reopening a conversation does not cover its content.
 * Semantics:
 * - fires once per streak key (workspace:session): after the widget has been
 *   opened (automatically or by the user) it does not re-open until the list
 *   fully disappears;
 * - a user close is respected for the rest of that streak;
 * - switching sessions resets the streak via the key;
 * - a loaded empty thread arms auto-open for the next newly-created list.
 */
export function useTodoAutoOpenOnce(todoVisible: boolean, streakKey: string, threadLoaded: boolean): { open: boolean; setOpen: (open: boolean) => void; close: () => void } {
  const open = useUiStore((s) => s.todoUiOpen);
  const setOpen = useUiStore((s) => s.setTodoUiOpen);
  const streakRef = useRef<{ key: string; opened: boolean; armed: boolean } | null>(null);

  useEffect(() => {
    if (!streakRef.current || streakRef.current.key !== streakKey) {
      streakRef.current = {
        key: streakKey,
        opened: todoVisible,
        armed: threadLoaded && !todoVisible,
      };
      setOpen(false);
      return;
    }
    if (!todoVisible) {
      setOpen(false);
      streakRef.current.opened = false;
      if (threadLoaded) streakRef.current.armed = true;
      return;
    }
    if (!streakRef.current.opened) {
      streakRef.current.opened = true;
      setOpen(streakRef.current.armed);
    }
  }, [todoVisible, streakKey, threadLoaded]);

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
