import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { allCommands, slashCommandsQuery } from "../lib/conversation";
import { useRuntimeStore } from "../lib/agent-runtime";
import {
  completionProviders,
  completionScope,
  completionView,
  completeQuery,
  detectCompletion,
  planAccept,
  planTab,
  type CompletionApply,
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
  setActive: (index: number) => void;
  dismiss: () => void;
}

export interface ComposerCompletion {
  menu: ComposerCompletionMenu | null;
  /** Consumes a key the candidate list owns. False means the composer's own key handling runs. */
  handleKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
}

/** A menu the user closed or opened by hand, keyed to the trigger token it was decided for. */
interface MenuOverride {
  /** `providerId:spanStart`, so the decision is forgotten when the caret moves to another token. */
  scope: string;
  /** The draft at decision time. */
  value: string;
  mode: "open" | "closed";
}

/** The decision lives while the draft is still the one it was made for, or a longer version of it.
 *  Extending the token keeps it, so Escape can hold a list shut while the user types the rest of a
 *  name. Clearing the draft or replacing the token ends it, so a dismissal can never leave a menu
 *  that cannot be reopened. */
function overrideIsLive(override: MenuOverride | null, scope: string | null, value: string): boolean {
  return Boolean(override && override.scope === scope && value.startsWith(override.value));
}

/** The composer's completion controller. It owns detection, the candidate list's open/closed
 *  state, and the keyboard contract; the composer owns the text and the caret. */
export function useComposerCompletion(params: {
  cwd: string;
  value: string;
  caret: number;
  /** The IME is composing: no list belongs on screen. `composingRef` keeps the keys. */
  composing: boolean;
  /** The composer's IME flag. While it is set every key belongs to the IME. */
  composingRef: RefObject<boolean>;
  onApply: (apply: CompletionApply) => void;
}): ComposerCompletion {
  const { cwd, value, caret, composing, composingRef, onApply } = params;
  const { t } = useTranslation();
  const listboxId = useId();
  const sessionId = useRuntimeStore((state) => state.cwd === cwd ? state.activeSessionId : null);
  const commandsQuery = useQuery(slashCommandsQuery(cwd, sessionId));
  // Providers look commands up by name, so the context carries the builtins and the discovered
  // `skill:*` commands together rather than the dynamic half alone.
  const commands = useMemo(() => allCommands(commandsQuery.data ?? []), [commandsQuery.data]);
  const agentsQuery = useQuery(subagentsDiscoveryQuery(cwd));
  const agents = useMemo(() => agentsQuery.data?.agents ?? [], [agentsQuery.data]);
  const [menuOverride, setMenuOverride] = useState<MenuOverride | null>(null);
  const [cursor, setCursor] = useState<{ key: string | null; index: number }>({ key: null, index: 0 });

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
    () => (detected ? completeQuery(detected, { value, caret, cwd, entries, agents, commands })
      .filter((item) => planAccept({ query: detected.query, item, value }).kind === "apply") : []),
    [agents, caret, commands, cwd, detected, entries, value],
  );

  const scope = detected ? completionScope(detected.query) : null;
  // An old row number must not select a different candidate after filtering or reordering.
  // Keep menu dismissal scoped to the token, but scope navigation to this exact candidate list.
  const cursorKey = detected ? JSON.stringify([cwd, scope, detected.query.query, items.map((item) => item.id)]) : null;
  useEffect(() => {
    setCursor((current) => current.key === cursorKey ? current : { key: cursorKey, index: 0 });
  }, [cursorKey]);
  const override = overrideIsLive(menuOverride, scope, value) ? menuOverride : null;
  const view = useMemo(
    () => completionView({
      detected,
      items,
      activeIndex: cursor.key === cursorKey ? cursor.index : 0,
      dismissedScope: override?.mode === "closed" ? override.scope : null,
      openedScope: override?.mode === "open" ? override.scope : null,
      composing,
    }),
    [composing, cursor, cursorKey, detected, items, override],
  );

  useEffect(() => {
    setMenuOverride((current) => (overrideIsLive(current, scope, value) ? current : null));
  }, [scope, value]);

  const dismiss = useCallback(() => {
    if (scope) setMenuOverride({ scope, value, mode: "closed" });
  }, [scope, value]);

  const select = useCallback((item: CompletionItem) => {
    if (!detected) return;
    const command = planAccept({ query: detected.query, item, value });
    if (command.kind === "apply") onApply(command);
  }, [detected, onApply, value]);

  const setActive = useCallback((index: number) => {
    setCursor((current) => current.key === cursorKey && current.index === index ? current : { key: cursorKey, index });
  }, [cursorKey]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean => {
    // An IME owns every key while it composes: Tab moves between its candidates and Enter
    // confirms them. The composer reads both isComposing and its own ref because some browsers
    // fire compositionend before keydown.
    if (event.nativeEvent.isComposing || composingRef.current) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!view.visible) return false;
      event.preventDefault();
      event.stopPropagation();
      if (scope) setMenuOverride({ scope, value, mode: "open" });
      if (cursorKey) setCursor({ key: cursorKey, index: Math.min(Math.max(view.activeIndex + (event.key === "ArrowDown" ? 1 : -1), 0), items.length - 1) });
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
      const command = planAccept({ query: detected?.query ?? null, item: view.activeItem, value });
      if (command.kind !== "apply") return false;
      onApply(command);
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      const command = planTab({ view, detected, items, value, caret });
      if (command.kind === "ignore") return false;
      if (scope) setMenuOverride({ scope, value, mode: "open" });
      if (command.kind === "apply") onApply(command);
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    return false;
  }, [caret, composingRef, cursorKey, detected, dismiss, items, onApply, scope, value, view]);

  const menu = useMemo<ComposerCompletionMenu | null>(() => {
    if (!view.visible) return null;
    const onlySubagents = items.every((item) => item.kind === "subagent");
    return {
      id: listboxId,
      label: onlySubagents ? t("conversation.subagentList") : t("conversation.completionList"),
      items,
      activeIndex: view.activeIndex,
      select,
      setActive,
      dismiss,
    };
  }, [dismiss, items, listboxId, select, setActive, t, view]);

  return { menu, handleKeyDown };
}
