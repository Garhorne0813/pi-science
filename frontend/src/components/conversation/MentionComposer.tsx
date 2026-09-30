import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import type { SubagentMention } from "../../lib/conversation";
import type { CompletionApply } from "../../lib/conversation/completion";
import { useComposerCompletion } from "../../hooks/useComposerCompletion";
import { useUiStore } from "../../lib/ui";
import { CompletionMenu } from "./CompletionMenu";

interface Props {
  cwd: string;
  value: string;
  mentions: SubagentMention[];
  onChange: (value: string, mentions: SubagentMention[]) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** The composer's IME flag, shared with the send pipeline: while it is set every key belongs
   *  to the IME, so no completion key is handled either. */
  composingRef: RefObject<boolean>;
  placeholder: string;
}

const COMPOSER_MIN_HEIGHT = 64;
const COMPOSER_MAX_HEIGHT = 160;

function changedRange(previous: string, next: string): { start: number; oldEnd: number; inserted: string } {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start += 1;
  let oldEnd = previous.length;
  let nextEnd = next.length;
  while (oldEnd > start && nextEnd > start && previous[oldEnd - 1] === next[nextEnd - 1]) {
    oldEnd -= 1;
    nextEnd -= 1;
  }
  return { start, oldEnd, inserted: next.slice(start, nextEnd) };
}

function mentionIntersectsEdit(mention: SubagentMention, start: number, oldEnd: number): boolean {
  if (start === oldEnd) return mention.start < start && start < mention.end;
  return start < mention.end && oldEnd > mention.start;
}

function renderHighlighted(value: string, mentions: SubagentMention[]) {
  const result: ReactNode[] = [];
  let cursor = 0;
  for (const mention of [...mentions].sort((a, b) => a.start - b.start)) {
    if (mention.start < cursor || mention.end > value.length) continue;
    result.push(value.slice(cursor, mention.start));
    result.push(
      <span key={mention.id} className="rounded bg-accent/15 text-accent ring-1 ring-inset ring-accent/20">
        {value.slice(mention.start, mention.end)}
      </span>,
    );
    cursor = mention.end;
  }
  result.push(value.slice(cursor));
  return result;
}

export function MentionComposer({ cwd, value, mentions, onChange, onKeyDown, onCompositionStart, onCompositionEnd, inputRef, composingRef, placeholder }: Props) {
  const { t } = useTranslation();
  const [caret, setCaret] = useState(value.length);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const selectionDirectionRef = useRef<"forward" | "backward" | "none">("none");
  const addWorkspaceReference = useUiStore((state) => state.addWorkspaceReference);

  useEffect(() => {
    const element = inputRef.current;
    if (element) setCaret(element.selectionEnd);
  }, [inputRef, value]);

  useLayoutEffect(() => {
    const element = inputRef.current;
    if (!element) return;

    // Reset the explicit height first so scrollHeight reflects the complete
    // content and the composer can shrink again after text is removed.
    const previousScrollTop = element.scrollTop;
    const caretWasAtEnd = element.selectionEnd === value.length;
    element.style.height = "0px";
    const contentHeight = element.scrollHeight;
    const nextHeight = Math.min(Math.max(contentHeight, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT);
    const overflowing = contentHeight > COMPOSER_MAX_HEIGHT;
    element.style.height = `${nextHeight}px`;
    element.style.overflowY = overflowing ? "auto" : "hidden";

    // Resetting the height can move the scroll position back to the top. Keep
    // edits elsewhere stable, but follow the caret to the bottom while the user
    // is appending text (including when Enter creates a new line).
    element.scrollTop = overflowing && caretWasAtEnd ? contentHeight : previousScrollTop;
    if (mirrorRef.current) mirrorRef.current.scrollTop = element.scrollTop;
  }, [inputRef, value]);

  const placeCaret = useCallback((position: number) => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
      setCaret(position);
    });
  }, [inputRef]);

  const handleChange = (nextValue: string) => {
    const edit = changedRange(value, nextValue);
    const affected = mentions.filter((mention) => mentionIntersectsEdit(mention, edit.start, edit.oldEnd));
    if (affected.length > 0) {
      const expandedStart = Math.min(edit.start, ...affected.map((mention) => mention.start));
      const expandedEnd = Math.max(edit.oldEnd, ...affected.map((mention) => mention.end));
      const repaired = value.slice(0, expandedStart) + edit.inserted + value.slice(expandedEnd);
      const delta = edit.inserted.length - (expandedEnd - expandedStart);
      const nextMentions = mentions
        .filter((mention) => !affected.includes(mention))
        .map((mention) => mention.start >= expandedEnd ? { ...mention, start: mention.start + delta, end: mention.end + delta } : mention);
      onChange(repaired, nextMentions);
      placeCaret(expandedStart + edit.inserted.length);
      return;
    }
    const delta = nextValue.length - value.length;
    const nextMentions = mentions.map((mention) => mention.start >= edit.oldEnd
      ? { ...mention, start: mention.start + delta, end: mention.end + delta }
      : mention);
    onChange(nextValue, nextMentions);
    setCaret(edit.start + edit.inserted.length);
  };

  const applyCompletion = useCallback((apply: CompletionApply) => {
    const delta = apply.caret - apply.end;
    const nextMentions = mentions
      .filter((mention) => !mentionIntersectsEdit(mention, apply.start, apply.end))
      .map((mention) => mention.start >= apply.end ? { ...mention, start: mention.start + delta, end: mention.end + delta } : mention);
    if (apply.payload?.kind === "mention") {
      const mention: SubagentMention = {
        id: `${apply.payload.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: apply.payload.name,
        start: apply.start,
        end: apply.start + apply.payload.token.length,
      };
      if (!nextMentions.some((existing) => existing.start === mention.start && existing.end === mention.end)) nextMentions.push(mention);
    }
    if (apply.payload?.kind === "reference") {
      addWorkspaceReference({ cwd, ...apply.payload.reference });
    }
    onChange(apply.value, nextMentions.sort((a, b) => a.start - b.start));
    placeCaret(apply.caret);
  }, [addWorkspaceReference, cwd, mentions, onChange, placeCaret]);

  const completion = useComposerCompletion({ cwd, value, caret, composingRef, onApply: applyCompletion });

  const handleSelect = (element: HTMLTextAreaElement) => {
    let start = element.selectionStart;
    let end = element.selectionEnd;
    const startMention = mentions.find((mention) => mention.start < start && start < mention.end);
    const endMention = mentions.find((mention) => mention.start < end && end < mention.end);
    if (start === end && startMention) {
      const snapped = start < (startMention.start + startMention.end) / 2 ? startMention.start : startMention.end;
      start = snapped;
      end = snapped;
    } else {
      if (startMention) start = startMention.start;
      if (endMention) end = endMention.end;
    }
    if (start !== element.selectionStart || end !== element.selectionEnd) element.setSelectionRange(start, end, selectionDirectionRef.current);
    selectionDirectionRef.current = element.selectionDirection;
    setCaret(end);
  };

  const handleKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (completion.handleKeyDown(event)) return;
    onKeyDown(event);
  };

  // Tab can carry focus out of the composer. The list belongs to the composer, so it goes with it
  // rather than staying on screen with no key left to close it.
  const handleBlur = () => {
    completion.menu?.dismiss();
  };

  const syncScroll = (element: HTMLTextAreaElement) => {
    if (!mirrorRef.current) return;
    mirrorRef.current.scrollTop = element.scrollTop;
    mirrorRef.current.scrollLeft = element.scrollLeft;
  };

  return (
    <>
      {completion.menu && (
        <CompletionMenu
          id={completion.menu.id}
          label={completion.menu.label}
          items={completion.menu.items}
          activeIndex={completion.menu.activeIndex}
          onSelect={completion.menu.select}
          onDismiss={completion.menu.dismiss}
        />
      )}
      <div className="relative min-h-[64px] max-h-[160px] overflow-hidden rounded-t-composer">
        <div
          ref={mirrorRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2 text-sm leading-6 text-text [clip-path:inset(8px_12px)]"
        >
          {renderHighlighted(value, mentions)}
          {value.endsWith("\n") ? "\n" : null}
        </div>
        <textarea
          ref={inputRef}
          value={value}
          role="combobox"
          aria-label={t("conversation.messageInput")}
          aria-expanded={completion.menu !== null}
          aria-controls={completion.menu?.id}
          aria-describedby={completion.menu ? `${completion.menu.id}-help` : undefined}
          aria-activedescendant={completion.menu ? `${completion.menu.id}-option-${completion.menu.activeIndex}` : undefined}
          aria-autocomplete="list"
          onChange={(event) => handleChange(event.target.value)}
          onSelect={(event) => handleSelect(event.currentTarget)}
          onKeyDown={handleKey}
          onBlur={handleBlur}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onScroll={(event) => syncScroll(event.currentTarget)}
          placeholder={placeholder}
          rows={2}
          className="relative z-10 min-h-[64px] max-h-[160px] w-full resize-none bg-transparent px-3 py-2 text-sm leading-6 text-transparent caret-text outline-none placeholder:text-muted selection:bg-accent/25"
        />
      </div>
    </>
  );
}
