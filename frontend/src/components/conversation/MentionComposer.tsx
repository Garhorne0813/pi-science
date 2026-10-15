import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import type { SubagentMention } from "../../lib/conversation";
import { applyComposerEdit, entityIntersectsEdit, updateComposerDocument, validComposerEntities, type ComposerEditIntent, type ComposerEntity } from "../../lib/conversation/composer-document";
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

interface ComposerSnapshot {
  value: string;
  entities: ComposerEntity[];
  selectionStart: number;
  selectionEnd: number;
}

function documentKey(value: string, entities: readonly ComposerEntity[]): string {
  return JSON.stringify([value, entities.map((entity) => entity.kind === "mention"
    ? [entity.kind, entity.id, entity.start, entity.end, entity.name]
    : [entity.kind, entity.id, entity.start, entity.end, entity.reference.cwd, entity.reference.path, entity.reference.isDir])]);
}

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
  const pendingIntentRef = useRef<ComposerEditIntent | null>(null);
  const undoHistoryRef = useRef<ComposerSnapshot[]>([]);
  const redoHistoryRef = useRef<ComposerSnapshot[]>([]);
  const pendingCaretRef = useRef<{ documentKey: string | null; start: number; end: number } | null>(null);
  const keyboardDirectionRef = useRef<"backward" | "forward" | null>(null);
  const chordHistoryRef = useRef<"undo" | "redo" | null>(null);
  const expectedDocumentKeyRef = useRef<string | null>(null);
  const activeEntities = validComposerEntities(value, entities ?? mentions.map((mention) => ({ ...mention, kind: "mention" as const })));
  const activeDocumentKey = documentKey(value, activeEntities);
  const observedDocumentKeyRef = useRef(activeDocumentKey);
  useLayoutEffect(() => {
    if (activeDocumentKey === observedDocumentKeyRef.current) return;
    observedDocumentKeyRef.current = activeDocumentKey;
    if (expectedDocumentKeyRef.current === activeDocumentKey) {
      expectedDocumentKeyRef.current = null;
      return;
    }
    undoHistoryRef.current = [];
    redoHistoryRef.current = [];
    pendingIntentRef.current = null;
  }, [activeDocumentKey]);
  const emitChange = useCallback((nextValue: string, nextEntities: ComposerEntity[]) => {
    const valid = validComposerEntities(nextValue, nextEntities);
    expectedDocumentKeyRef.current = documentKey(nextValue, valid);
    onChange(nextValue, valid.filter((entity) => entity.kind === "mention").map(({ id, name, start, end }) => ({ id, name, start, end })), valid);
  }, [onChange]);

  const snapshot = useCallback((start?: number, end?: number): ComposerSnapshot => {
    const element = inputRef.current;
    return {
      value,
      entities: activeEntities.map((entity) => ({ ...entity })),
      selectionStart: start ?? element?.selectionStart ?? caret,
      selectionEnd: end ?? element?.selectionEnd ?? caret,
    };
  }, [activeEntities, caret, inputRef, value]);

  const rememberEdit = useCallback((before: ComposerSnapshot) => {
    const stack = undoHistoryRef.current;
    if (stack.length === 0 || documentKey(stack[stack.length - 1]!.value, stack[stack.length - 1]!.entities) !== documentKey(before.value, before.entities)) {
      stack.push(before);
      if (stack.length > 100) stack.shift();
    }
    redoHistoryRef.current = [];
  }, []);

  const applyCaretRequest = useCallback((request: { start: number; end: number }) => {
    const element = inputRef.current;
    if (!element) return;
    element.focus();
    element.setSelectionRange(request.start, request.end);
    setCaret(request.end);
  }, [inputRef]);

  const placeCaret = useCallback((start: number, end = start) => {
    const request = { documentKey: expectedDocumentKeyRef.current, start, end };
    pendingCaretRef.current = request;
    // Nothing to wait for when the document this caret belongs to is already on screen.
    if (request.documentKey === null) {
      pendingCaretRef.current = null;
      applyCaretRequest(request);
    }
  }, [applyCaretRequest]);

  const restoreHistory = useCallback((direction: "undo" | "redo") => {
    const source = direction === "undo" ? undoHistoryRef.current : redoHistoryRef.current;
    const destination = direction === "undo" ? redoHistoryRef.current : undoHistoryRef.current;
    const target = source.pop();
    if (!target) return false;
    destination.push(snapshot());
    emitChange(target.value, target.entities);
    placeCaret(target.selectionStart, target.selectionEnd);
    return true;
  }, [emitChange, placeCaret, snapshot]);

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

  // The placement runs inside the commit that carries its document, so no keystroke or click can land
  // between the value change and the caret. A request whose document never arrived is dropped.
  useLayoutEffect(() => {
    const request = pendingCaretRef.current;
    if (!request) return;
    pendingCaretRef.current = null;
    if (request.documentKey !== activeDocumentKey) return;
    applyCaretRequest(request);
  }, [activeDocumentKey, applyCaretRequest]);

  const handleChange = (nextValue: string) => {
    const intent = pendingIntentRef.current;
    pendingIntentRef.current = null;
    const change = intent
      ? applyComposerEdit({ value, entities: activeEntities }, intent, nextValue)
      : updateComposerDocument({ value, entities: activeEntities }, nextValue);
    rememberEdit(intent
      ? { value: intent.value, entities: intent.entities.map((entity) => ({ ...entity })), selectionStart: intent.selectionStart, selectionEnd: intent.selectionEnd }
      : snapshot());
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
    rememberEdit(snapshot());
    emitChange(apply.value, nextEntities);
    placeCaret(apply.caret);
  }, [activeEntities, cwd, emitChange, placeCaret, rememberEdit, snapshot, value]);

  const completion = useComposerCompletion({ cwd, value, caret, composing, composingRef, onApply: applyCompletion });

  const handleSelect = (element: HTMLTextAreaElement) => {
    const direction = element.selectionDirection;
    let start = element.selectionStart;
    let end = element.selectionEnd;
    if (composing || composingRef.current) { setCaret(end); return; }
    // Only a keyboard move carries a direction of travel; a pointer click keeps the nearest-half rule.
    const travel = keyboardDirectionRef.current;
    keyboardDirectionRef.current = null;
    const startMention = activeEntities.find((entity) => entity.start < start && start < entity.end);
    const endMention = activeEntities.find((entity) => entity.start < end && end < entity.end);
    if (start === end && startMention) {
      const crossed = travel === "backward" ? startMention.start : travel === "forward" ? startMention.end : null;
      const snapped = crossed ?? (start < (startMention.start + startMention.end) / 2 ? startMention.start : startMention.end);
      start = snapped;
      end = snapped;
    } else {
      if (startMention) start = startMention.start;
      if (endMention) end = endMention.end;
    }
    if (start !== element.selectionStart || end !== element.selectionEnd) element.setSelectionRange(start, end, direction);
    setCaret(end);
  };

  const handleKey = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (completion.handleKeyDown(event)) return;
    const pressed = event.metaKey || event.ctrlKey ? event.key.toLowerCase() : "";
    const undoChord = pressed === "z" && !event.shiftKey;
    const redoChord = !undoChord && ((pressed === "z" && event.shiftKey) || (event.ctrlKey && pressed === "y"));
    // A keystroke that is not this chord closes the window for the event it may have paired with.
    if (!undoChord && !redoChord) chordHistoryRef.current = null;
    if ((undoChord || redoChord) && !event.nativeEvent.isComposing && !composingRef.current) {
      // A native history step would move the text without its bindings, and the platform stops
      // offering its own redo once this stack cancels the undo, so the chord belongs here.
      event.preventDefault();
      const direction = undoChord ? "undo" : "redo";
      chordHistoryRef.current = direction;
      restoreHistory(direction);
      return;
    }
    const arrow = event.key === "ArrowLeft" || event.key === "ArrowRight";
    if (arrow && !event.nativeEvent.isComposing && !composingRef.current) keyboardDirectionRef.current = event.key === "ArrowLeft" ? "backward" : "forward";
    if (!event.nativeEvent.isComposing && !composingRef.current && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey && arrow) {
      const element = event.currentTarget;
      if (element.selectionStart === element.selectionEnd) {
        const target = activeEntities.find((entity) => event.key === "ArrowLeft" ? entity.end === element.selectionStart : entity.start === element.selectionStart);
        if (target) {
          event.preventDefault();
          const position = event.key === "ArrowLeft" ? target.start : target.end;
          element.setSelectionRange(position, position);
          setCaret(position);
          return;
        }
      }
    }
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
          rememberEdit(snapshot());
          emitChange(nextValue, nextEntities);
          placeCaret(target.start);
          return;
        }
      }
    }
    onKeyDown(event);
  };

  const handleBeforeInput = useCallback((native: InputEvent) => {
    if (native.inputType === "historyUndo" || native.inputType === "historyRedo") {
      native.preventDefault();
      pendingIntentRef.current = null;
      const direction = native.inputType === "historyUndo" ? "undo" : "redo";
      // A browser that still delivers the event after the chord must not move the stack twice.
      if (chordHistoryRef.current === direction) {
        chordHistoryRef.current = null;
        return;
      }
      restoreHistory(direction);
      return;
    }
    const element = inputRef.current;
    if (!element) return;
    pendingIntentRef.current = {
      value,
      entities: activeEntities.map((entity) => ({ ...entity })),
      selectionStart: element.selectionStart,
      selectionEnd: element.selectionEnd,
      inputType: native.inputType ?? "",
    };
  }, [activeEntities, inputRef, restoreHistory, value]);

  // React's delegated onBeforeInput does not consistently receive native historyUndo/Redo
  // events. Listen on the textarea itself so the edit intent is captured before React onChange.
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.addEventListener("beforeinput", handleBeforeInput);
    return () => element.removeEventListener("beforeinput", handleBeforeInput);
  }, [handleBeforeInput, inputRef]);

  const cancelPendingCaret = () => {
    // Cancel on pointerdown/blur, not select. Completion placement also emits select.
    pendingCaretRef.current = null;
    keyboardDirectionRef.current = null;
  };

  // Tab can carry focus out of the composer. The list belongs to the composer, so it goes with it
  // rather than staying on screen with no key left to close it.
  const handleBlur = () => {
    cancelPendingCaret();
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
          loading={completion.menu.loading}
          error={completion.menu.error}
          empty={completion.menu.empty}
          retry={completion.menu.retry}
          breadcrumbs={completion.menu.breadcrumbs}
          navigate={completion.menu.navigate}
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
          aria-activedescendant={completion.menu && completion.menu.items.length > 0 ? `${completion.menu.id}-option-${completion.menu.activeIndex}` : undefined}
          aria-autocomplete="list"
          onChange={(event) => handleChange(event.target.value)}
          onSelect={(event) => handleSelect(event.currentTarget)}
          onKeyDown={handleKey}
          onPointerDown={cancelPendingCaret}
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

