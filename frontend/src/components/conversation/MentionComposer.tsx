import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import type { SubagentMention } from "../../lib/conversation";
import { entityIntersectsEdit, updateComposerDocument, validComposerEntities, type ComposerEntity } from "../../lib/conversation/composer-document";
import type { CompletionApply } from "../../lib/conversation/completion";
import { useComposerCompletion } from "../../hooks/useComposerCompletion";
import { CompletionMenu } from "./CompletionMenu";

interface Props {
  cwd: string;
  value: string;
  /** Legacy mention input is retained for existing stand-alone consumers. */
  mentions?: SubagentMention[];
  entities?: ComposerEntity[];
  onChange: (value: string, mentions: SubagentMention[], entities: ComposerEntity[]) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  /** The composer's IME flag for rendering: the menu hides while the IME composes. */
  composing: boolean;
  /** The composer's IME flag, shared with the send pipeline: while it is set every key belongs
   *  to the IME, so no completion key is handled either. */
  composingRef: RefObject<boolean>;
  placeholder: string;
}

const COMPOSER_MIN_HEIGHT = 64;
const COMPOSER_MAX_HEIGHT = 160;

function renderHighlighted(value: string, entities: ComposerEntity[]) {
  const result: ReactNode[] = [];
  let cursor = 0;
  for (const mention of validComposerEntities(value, entities)) {
    if (mention.start < cursor || mention.end > value.length) continue;
    result.push(value.slice(cursor, mention.start));
    result.push(
      <span key={mention.id} className={mention.kind === "reference" ? "rounded bg-accent/15 text-accent ring-1 ring-inset ring-accent/30" : "rounded bg-accent/15 text-accent ring-1 ring-inset ring-accent/20"}>
        {value.slice(mention.start, mention.end)}
      </span>,
    );
    cursor = mention.end;
  }
  result.push(value.slice(cursor));
  return result;
}

export function MentionComposer({ cwd, value, mentions = [], entities, onChange, onKeyDown, onCompositionStart, onCompositionEnd, inputRef, composing, composingRef, placeholder }: Props) {
  const { t } = useTranslation();
  const [caret, setCaret] = useState(value.length);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const selectionDirectionRef = useRef<"forward" | "backward" | "none">("none");
  const activeEntities: ComposerEntity[] = entities ?? mentions.map((mention) => ({ ...mention, kind: "mention" as const }));
  const emitChange = (nextValue: string, nextEntities: ComposerEntity[]) => {
    const valid = validComposerEntities(nextValue, nextEntities);
    onChange(nextValue, valid.filter((entity) => entity.kind === "mention").map(({ id, name, start, end }) => ({ id, name, start, end })), valid);
  };

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
    const change = updateComposerDocument({ value, entities: activeEntities }, nextValue);
    emitChange(change.value, change.entities);
    if (change.value !== nextValue) placeCaret(change.caret);
    else setCaret(change.caret);
  };

  const applyCompletion = useCallback((apply: CompletionApply) => {
    const delta = apply.value.length - value.length;
    const nextEntities = activeEntities
      .filter((entity) => !entityIntersectsEdit(entity, apply.start, apply.end))
      .map((entity) => entity.start >= apply.end
        ? { ...entity, start: entity.start + delta, end: entity.end + delta } : entity);
    if (apply.payload?.kind === "mention") {
      nextEntities.push({
        kind: "mention",
        id: `mention-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: apply.payload.name,
        start: apply.start,
        end: apply.start + apply.payload.token.length,
      });
    }
    if (apply.payload?.kind === "reference") {
      nextEntities.push({
        kind: "reference",
        id: `reference-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        start: apply.start,
        end: apply.start + `@${apply.payload.reference.path}`.length,
        reference: { cwd, ...apply.payload.reference },
      });
    }
    emitChange(apply.value, nextEntities);
    placeCaret(apply.caret);
  }, [activeEntities, cwd, onChange, placeCaret, value]);

  const completion = useComposerCompletion({ cwd, value, caret, composing, composingRef, onApply: applyCompletion });

  const handleSelect = (element: HTMLTextAreaElement) => {
    let start = element.selectionStart;
    let end = element.selectionEnd;
    if (composing || composingRef.current) { setCaret(end); return; }
    const startMention = activeEntities.find((entity) => entity.start < start && start < entity.end);
    const endMention = activeEntities.find((entity) => entity.start < end && end < entity.end);
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
    if (!event.nativeEvent.isComposing && !composingRef.current && (event.key === "Backspace" || event.key === "Delete")) {
      const element = event.currentTarget;
      if (element.selectionStart === element.selectionEnd) {
        const position = element.selectionStart;
        const target = activeEntities.find((entity) =>
          event.key === "Backspace" ? entity.end === position : entity.start === position);
        if (target) {
          event.preventDefault();
          const nextValue = value.slice(0, target.start) + value.slice(target.end);
          const nextEntities = activeEntities.filter((entity) => entity !== target)
            .map((entity) => entity.start >= target.end
              ? { ...entity, start: entity.start - (target.end - target.start), end: entity.end - (target.end - target.start) } : entity);
          emitChange(nextValue, nextEntities);
          placeCaret(target.start);
          return;
        }
      }
    }
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
          onActiveChange={completion.menu.setActive}
          onDismiss={completion.menu.dismiss}
          inputRef={inputRef}
        />
      )}
      <div className="relative min-h-[64px] max-h-[160px] overflow-hidden rounded-t-composer">
        <div
          ref={mirrorRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2 text-sm leading-6 text-text [clip-path:inset(8px_12px)]"
        >
          {renderHighlighted(value, activeEntities)}
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
