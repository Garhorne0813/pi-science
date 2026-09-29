import { useCallback, useId, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { allCommands, getDynamicCommandsSnapshot, subscribeDynamicCommands } from "../lib/conversation";
import {
  completionProviders,
  completionScope,
  completionView,
  completeQuery,
  detectCompletion,
  planAccept,
  planTab,
  type CompletionApply,
  type CompletionCommand,
  type CompletionItem,
} from "../lib/conversation/completion";
import { subagentsDiscoveryQuery } from "../lib/settings";
import { workspaceFilesQuery } from "../lib/workspace/workspace-files";

/** Everything the candidate menu needs, or null while no list belongs on screen. */
export interface ComposerCompletionMenu {
  id: string;
  label: string;
  items: CompletionItem[];
  activeIndex: number;
  select: (item: CompletionItem) => void;
  dismiss: () => void;
}

export interface ComposerCompletion {
  menu: ComposerCompletionMenu | null;
  /** Consumes a key the candidate list owns. False means the composer's own key handling runs. */
  handleKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/** A menu the user closed or opened by hand, keyed to the trigger token it was decided for. The
 *  decision outlives typing inside that token and dies with it. */
interface MenuOverride {
  scope: string;
  mode: "open" | "closed";
}

/** The composer's completion controller. It owns detection, the candidate list's open/closed
 *  state, and the keyboard contract; the composer owns the text and the caret. */
export function useComposerCompletion(params: {
  cwd: string;
  value: string;
  caret: number;
  /** The composer's IME flag. While it is set every key belongs to the IME. */
  composingRef: RefObject<boolean>;
  onApply: (apply: CompletionApply) => void;
}): ComposerCompletion {
  const { cwd, value, caret, composingRef, onApply } = params;
  const { t } = useTranslation();
  const listboxId = useId();
  const dynamicCommands = useSyncExternalStore(subscribeDynamicCommands, getDynamicCommandsSnapshot, getDynamicCommandsSnapshot);
  // Providers look commands up by name, so the context carries the builtins and the discovered
  // `skill:*` commands together rather than the dynamic half alone.
  const commands = useMemo(() => allCommands(dynamicCommands), [dynamicCommands]);
  const agentsQuery = useQuery(subagentsDiscoveryQuery(cwd));
  const agents = useMemo(() => agentsQuery.data?.agents ?? [], [agentsQuery.data]);
  const [menuOverride, setMenuOverride] = useState<MenuOverride | null>(null);
  const [cursor, setCursor] = useState<{ scope: string | null; index: number }>({ scope: null, index: 0 });

  // Detection reads the text and the catalogues only, so it can run before the directory for
  // the detected token is loaded.
  const detected = useMemo(
    () => detectCompletion(completionProviders, { value, caret, cwd, entries: [], agents, commands }),
    [agents, caret, commands, cwd, value],
  );
  const subdir = detected?.query.directory?.subdir ?? null;
  const directoryQuery = useQuery({ ...workspaceFilesQuery(cwd, subdir ?? ""), enabled: subdir !== null });
  const entries = useMemo(() => {
    // A malformed payload leaves the candidate list empty instead of blocking typing.
    if (directoryQuery.data && !Array.isArray(directoryQuery.data.entries)) return [];
    return directoryQuery.data?.entries ?? [];
  }, [directoryQuery.data]);

  const items = useMemo(
    () => (detected ? completeQuery(detected, { value, caret, cwd, entries, agents, commands }) : []),
    [agents, caret, commands, cwd, detected, entries, value],
  );

  const scope = detected ? completionScope(detected.query) : null;
  const view = useMemo(
    () => completionView({
      detected,
      items,
      activeIndex: cursor.scope === scope ? cursor.index : 0,
      dismissedScope: menuOverride?.mode === "closed" ? menuOverride.scope : null,
      openedScope: menuOverride?.mode === "open" ? menuOverride.scope : null,
    }),
    [cursor, detected, items, menuOverride, scope],
  );

  const dismiss = useCallback(() => {
    if (scope) setMenuOverride({ scope, mode: "closed" });
  }, [scope]);

  const select = useCallback((item: CompletionItem) => {
    if (!detected) return;
    const command = planAccept({ query: detected.query, item, value });
    if (command.kind === "apply") onApply(command);
  }, [detected, onApply, value]);

  const runCommand = useCallback((command: CompletionCommand): boolean => {
    if (command.kind === "ignore") return false;
    if (command.kind === "open-menu") {
      if (scope) setMenuOverride({ scope, mode: "open" });
      return true;
    }
    onApply(command);
    return true;
  }, [onApply, scope]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    // An IME owns every key while it composes: Tab moves between its candidates and Enter
    // confirms them. The composer reads both isComposing and its own ref because some browsers
    // fire compositionend before keydown.
    if (event.nativeEvent.isComposing || composingRef.current) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!view.visible) return false;
      event.preventDefault();
      event.stopPropagation();
      if (scope) setCursor({ scope, index: Math.min(Math.max(view.activeIndex + (event.key === "ArrowDown" ? 1 : -1), 0), items.length - 1) });
      return true;
    }
    if (event.key === "Escape") {
      if (!view.visible) return false;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (!view.visible) return false;
      if (!runCommand(planAccept({ query: detected?.query ?? null, item: view.activeItem, value }))) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      if (!runCommand(planTab({ view, detected, items, value, caret }))) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    return false;
  }, [caret, composingRef, detected, dismiss, items, runCommand, scope, value, view]);

  const menu = useMemo<ComposerCompletionMenu | null>(() => {
    if (!view.visible) return null;
    const onlySubagents = items.every((item) => item.kind === "subagent");
    return {
      id: listboxId,
      label: onlySubagents ? t("conversation.subagentList") : t("conversation.completionList"),
      items,
      activeIndex: view.activeIndex,
      select,
      dismiss,
    };
  }, [dismiss, items, listboxId, select, t, view]);

  return { menu, handleKeyDown };
}
