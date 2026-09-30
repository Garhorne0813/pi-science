import type {
  CompletionCommand,
  CompletionContext,
  CompletionItem,
  CompletionProvider,
  CompletionQuery,
} from "./types";

/** A provider plus the token it claimed at the caret. */
export type DetectedCompletion = { provider: CompletionProvider; query: CompletionQuery };

/** Two detections share a scope while the user edits the same trigger token. The menu's open or
 *  closed decision lives on the scope, so it survives typing inside the token and is forgotten as
 *  soon as the caret moves to another one. */
export function completionScope(query: CompletionQuery): string {
  return `${query.providerId}:${query.start}`;
}

export function detectCompletion(
  providers: readonly CompletionProvider[],
  context: CompletionContext,
): DetectedCompletion | null {
  for (const provider of providers) {
    try {
      const query = provider.detect(context);
      if (query) return { provider, query };
    } catch {
      // A broken or missing data source must never block typing, so a throwing provider is
      // skipped and the next one gets the query.
    }
  }
  return null;
}

export function completeQuery(
  detected: DetectedCompletion,
  context: CompletionContext,
): CompletionItem[] {
  try {
    return detected.provider.complete(detected.query, context);
  } catch {
    return [];
  }
}

export function commonPrefix(items: readonly CompletionItem[]): string {
  if (items.length === 0) return "";
  let prefix = items[0].insertText;
  for (let index = 1; index < items.length && prefix.length > 0; index += 1) {
    const text = items[index].insertText;
    let end = 0;
    while (end < prefix.length && end < text.length && prefix[end] === text[end]) end += 1;
    prefix = prefix.slice(0, end);
  }
  return prefix;
}

export type CompletionView = {
  /** The candidate list is on screen. */
  visible: boolean;
  /** The candidate list exists for this caret, visible or not. */
  available: boolean;
  activeIndex: number;
  activeItem: CompletionItem | null;
};

export function completionView(input: {
  detected: DetectedCompletion | null;
  items: readonly CompletionItem[];
  activeIndex: number;
  /** Scope the user closed with Escape. */
  dismissedScope: string | null;
  /** Scope the user opened with Tab for a query that does not open by itself. */
  openedScope: string | null;
  /** The IME is composing, so no list belongs on screen. */
  composing: boolean;
}): CompletionView {
  const { detected, items } = input;
  const scope = detected ? completionScope(detected.query) : null;
  const available = detected !== null && items.length > 0 && scope !== input.dismissedScope;
  const visible = available && detected !== null && !input.composing && (detected.query.autoOpen || scope === input.openedScope);
  const activeIndex = Math.min(Math.max(input.activeIndex, 0), Math.max(items.length - 1, 0));
  return { visible, available, activeIndex, activeItem: items[activeIndex] ?? null };
}

export function planTab(input: {
  view: CompletionView;
  detected: DetectedCompletion | null;
  items: readonly CompletionItem[];
  value: string;
  caret: number;
}): CompletionCommand {
  const { view, detected, items, value } = input;
  if (view.visible) return planAccept({ query: detected?.query ?? null, item: view.activeItem, value });
  if (!detected || items.length === 0) return { kind: "ignore" };
  if (!view.available) return { kind: "open-menu" };
  const { query } = detected;
  const prefix = commonPrefix(items);
  if (prefix.length > query.query.length) {
    return {
      kind: "apply",
      value: value.slice(0, query.start) + prefix + value.slice(query.end),
      caret: query.start + prefix.length,
      start: query.start,
      end: query.end,
    };
  }
  // A lone candidate that the token already spells has nothing left to complete, so Tab keeps its
  // normal meaning instead of opening a list of one.
  if (items.length === 1 && items[0].insertText === query.query) return { kind: "ignore" };
  return { kind: "open-menu" };
}

export function planAccept(input: {
  query: CompletionQuery | null;
  item: CompletionItem | null;
  value: string;
}): CompletionCommand {
  const { query, item, value } = input;
  if (!query || !item) return { kind: "ignore" };
  const end = item.replaceEnd ?? query.end;
  const next = value.slice(0, query.start) + item.insertText + value.slice(end);
  // An exact match has nothing left to complete, so the key falls through to its normal meaning.
  // A candidate that fills a structured slot still applies: the text is already right, and the
  // mention or reference it carries does not exist yet.
  if (next === value && !item.payload) return { kind: "ignore" };
  return {
    kind: "apply",
    value: next,
    caret: query.start + item.insertText.length,
    start: query.start,
    end,
    payload: item.payload,
  };
}
