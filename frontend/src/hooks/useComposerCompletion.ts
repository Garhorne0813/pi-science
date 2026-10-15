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
import { workspaceFilesQuery, type Breadcrumb } from "../lib/workspace/workspace-files";

/** Everything the candidate menu needs, or null while no list belongs on screen. */
export interface ComposerCompletionMenu {
  id: string;
  label: string;
  items: CompletionItem[];
  activeIndex: number;
  select: (item: CompletionItem) => void;
  setActive: (index: number) => void;
  dismiss: () => void;
  loading?: boolean;
  error?: boolean;
  empty?: boolean;
  retry?: () => void;
  breadcrumbs?: Breadcrumb[];
  navigate?: (path: string) => void;
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
  const detectedScope = detected ? completionScope(detected.query) : null;
  // `path: null` means no hand navigation yet, `path: ""` means the user navigated to the workspace
  // root. Keeping them apart is what lets the root breadcrumb leave the typed directory.
  const [browseState, setBrowseState] = useState<{ scope: string; path: string | null; query: string }>({ scope: "", path: null, query: "" });
  const browsePath = detected?.query.providerId === "mention"
    && browseState.scope === detectedScope && browseState.query === detected.query.query ? browseState.path : null;
  const effectiveDetected = useMemo(() => {
    if (!detected || detected.query.providerId !== "mention" || !detected.query.directory || browsePath === null) return detected;
    return {
      ...detected,
      query: {
        ...detected.query,
        directory: { ...detected.query.directory, subdir: browsePath, prefix: "", base: browsePath ? `${browsePath}/` : "" },
      },
    };
  }, [browsePath, detected]);
  useEffect(() => {
    const currentQuery = detected?.query.query ?? "";
    if (browseState.scope !== detectedScope || browseState.query !== currentQuery) {
      setBrowseState({ scope: detectedScope ?? "", path: null, query: currentQuery });
    }
  }, [browseState.query, browseState.scope, detected, detectedScope]);
  const subdir = effectiveDetected?.query.directory?.subdir ?? null;
  const directoryQuery = useQuery({ ...workspaceFilesQuery(cwd, subdir ?? ""), enabled: subdir !== null });
  const entries = useMemo(() => {
    // A malformed payload leaves the candidate list empty instead of blocking typing.
    if (directoryQuery.data && !Array.isArray(directoryQuery.data.entries)) return [];
    return directoryQuery.data?.entries ?? [];
  }, [directoryQuery.data]);

  const items = useMemo(
    () => (effectiveDetected ? completeQuery(effectiveDetected, { value, caret, cwd, entries, agents, commands, browsePath: browsePath ?? undefined })
      .filter((item) => ["apply", "navigate-directory"].includes(planAccept({ query: effectiveDetected.query, item, value }).kind)) : []),
    [agents, browsePath, caret, commands, cwd, effectiveDetected, entries, value],
  );

  const scope = detectedScope;
  // An old row number must not select a different candidate after filtering or reordering.
  // Keep menu dismissal scoped to the token, but scope navigation to this exact candidate list.
  const cursorKey = detected ? JSON.stringify([cwd, scope, detected.query.query, items.map((item) => item.id)]) : null;
  useEffect(() => {
    setCursor((current) => current.key === cursorKey ? current : { key: cursorKey, index: 0 });
  }, [cursorKey]);
  const override = overrideIsLive(menuOverride, scope, value) ? menuOverride : null;
  const statusLoading = (detected?.query.providerId === "slash" && commandsQuery.isFetching)
    || (effectiveDetected?.query.providerId === "mention" && directoryQuery.isFetching);
  // Slash discovery errors stay visible alongside builtins so users can retry without
  // confusing a partial catalog for the complete command set.
  const statusError = (detected?.query.providerId === "slash" && commandsQuery.isError)
    || (effectiveDetected?.query.providerId === "mention" && directoryQuery.isError);
  const statusVisible = !composing && override?.mode !== "closed" && (statusLoading || statusError);
  const emptyVisible = !composing && override?.mode !== "closed"
    && effectiveDetected?.query.providerId === "mention"
    && Boolean(effectiveDetected.query.directory)
    && items.length === 0 && !directoryQuery.isFetching && !directoryQuery.isError;
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

  const runCommand = useCallback((command: ReturnType<typeof planAccept>, closeAfterAccept = false) => {
    if (command.kind === "open-menu") return true;
    if (command.kind === "navigate-directory") {
      if (scope && effectiveDetected) setBrowseState({ scope, path: command.path, query: effectiveDetected.query.query });
      return true;
    }
    if (command.kind === "apply") {
      onApply(command);
      // A selected Slash command can leave the caret inside the same token
      // (for example, when it has no arguments). Keep that accepted command
      // from immediately reopening the candidate list.
      if (closeAfterAccept && scope && effectiveDetected?.query.providerId === "slash") {
        setMenuOverride({ scope, value: command.value, mode: "closed" });
      }
      return true;
    }
    return false;
  }, [effectiveDetected, onApply, scope]);

  const select = useCallback((item: CompletionItem) => {
    if (!effectiveDetected) return;
    runCommand(planAccept({ query: effectiveDetected.query, item, value }), true);
  }, [effectiveDetected, runCommand, value]);

  const setActive = useCallback((index: number) => {
    setCursor((current) => current.key === cursorKey && current.index === index ? current : { key: cursorKey, index });
  }, [cursorKey]);

  const retry = useCallback(() => {
    if (detected?.query.providerId === "slash") void commandsQuery.refetch();
    if (effectiveDetected?.query.providerId === "mention") void directoryQuery.refetch();
  }, [commandsQuery, detected, directoryQuery, effectiveDetected]);

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
      if (!view.visible && !statusVisible) return false;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (!view.visible) return false;
      const command = planAccept({ query: effectiveDetected?.query ?? null, item: view.activeItem, value });
      if (!runCommand(command, true)) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      const command = planTab({ view, detected: effectiveDetected, items, value, caret });
      if (command.kind === "ignore") return false;
      if (scope) setMenuOverride({ scope, value, mode: "open" });
      if (!runCommand(command, view.visible)) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    return false;
  }, [caret, composingRef, cursorKey, dismiss, effectiveDetected, items, runCommand, scope, statusVisible, value, view]);

  const menu = useMemo<ComposerCompletionMenu | null>(() => {
    if (!view.visible && !statusVisible && !emptyVisible) return null;
    const onlySubagents = items.length > 0 && items.every((item) => item.kind === "subagent");
    return {
      id: listboxId,
      label: onlySubagents ? t("conversation.subagentList") : t("conversation.completionList"),
      items,
      activeIndex: view.activeIndex,
      select,
      setActive,
      dismiss,
      loading: statusLoading,
      error: statusError,
      empty: emptyVisible,
      retry,
      breadcrumbs: effectiveDetected?.query.providerId === "mention" ? directoryQuery.data?.breadcrumbs : undefined,
      navigate: (path) => { if (scope && effectiveDetected) setBrowseState({ scope, path, query: effectiveDetected.query.query }); },
    };
  }, [directoryQuery, dismiss, effectiveDetected, emptyVisible, items, listboxId, retry, statusError, statusLoading, statusVisible, scope, select, setActive, t, view]);

  return { menu, handleKeyDown };
}

