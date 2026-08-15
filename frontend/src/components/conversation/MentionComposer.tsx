import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import type { SubagentMention } from "../../lib/conversation";
import { queryClient } from "../../lib/client/query-client";
import { subagentsDiscoveryQuery } from "../../lib/settings";
import { cn } from "../../lib/ui";

interface AvailableSubagent {
  name: string;
  description?: string;
  source?: string;
}

interface Props {
  cwd: string;
  value: string;
  mentions: SubagentMention[];
  onChange: (value: string, mentions: SubagentMention[]) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  placeholder: string;
}

interface Trigger {
  start: number;
  query: string;
}

function triggerAt(value: string, caret: number): Trigger | null {
  const before = value.slice(0, caret);
  const match = before.match(/(?:^|[\s([{])@([a-z0-9_-]*)$/i);
  if (!match) return null;
  return { start: caret - match[1].length - 1, query: match[1].toLowerCase() };
}

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

export function MentionComposer({ cwd, value, mentions, onChange, onKeyDown, onCompositionStart, onCompositionEnd, inputRef, placeholder }: Props) {
  const [agents, setAgents] = useState<AvailableSubagent[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedStart, setDismissedStart] = useState<number | null>(null);
  const [caret, setCaret] = useState(value.length);
  const menuRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const selectionDirectionRef = useRef<"forward" | "backward" | "none">("none");
  const listboxId = useId();

  useEffect(() => {
    let cancelled = false;
    void queryClient.fetchQuery(subagentsDiscoveryQuery(cwd))
      .then((data) => { if (!cancelled) setAgents(data.agents ?? []); })
      .catch(() => { if (!cancelled) setAgents([]); });
    return () => { cancelled = true; };
  }, [cwd]);

  useEffect(() => {
    const element = inputRef.current;
    if (element) setCaret(element.selectionEnd);
  }, [inputRef, value]);

  const trigger = useMemo(() => triggerAt(value, caret), [caret, value]);
  const choices = useMemo(() => {
    if (!trigger || dismissedStart === trigger.start) return [];
    return agents.filter((agent) => agent.name.toLowerCase().includes(trigger.query));
  }, [agents, dismissedStart, trigger]);

  useEffect(() => setActiveIndex(0), [trigger?.query, choices.length]);
  useEffect(() => {
    const activeOption = optionRefs.current[activeIndex];
    if (activeOption && typeof activeOption.scrollIntoView === "function") {
      activeOption.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex]);
  useEffect(() => {
    if (dismissedStart !== null && value[dismissedStart] !== "@") setDismissedStart(null);
  }, [dismissedStart, value]);

  const dismiss = useCallback(() => {
    if (trigger) setDismissedStart(trigger.start);
  }, [trigger]);

  useEffect(() => {
    if (choices.length === 0) return undefined;
    const pointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !menuRef.current?.contains(target)) dismiss();
    };
    document.addEventListener("pointerdown", pointerDown, true);
    return () => document.removeEventListener("pointerdown", pointerDown, true);
  }, [choices.length, dismiss]);

  const placeCaret = useCallback((position: number) => {
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
      setCaret(position);
    });
  }, [inputRef]);

  const selectAgent = useCallback((agent: AvailableSubagent) => {
    if (!trigger) return;
    const token = `@${agent.name}`;
    const suffix = value.slice(caret).startsWith(" ") ? "" : " ";
    const inserted = `${token}${suffix}`;
    const replacedLength = caret - trigger.start;
    const delta = inserted.length - replacedLength;
    const nextMentions = mentions
      .filter((mention) => mention.end <= trigger.start || mention.start >= caret)
      .map((mention) => mention.start >= caret ? { ...mention, start: mention.start + delta, end: mention.end + delta } : mention);
    nextMentions.push({
      id: `${agent.name}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: agent.name,
      start: trigger.start,
      end: trigger.start + token.length,
    });
    const next = value.slice(0, trigger.start) + inserted + value.slice(caret);
    setDismissedStart(null);
    onChange(next, nextMentions.sort((a, b) => a.start - b.start));
    placeCaret(trigger.start + inserted.length);
  }, [caret, mentions, onChange, placeCaret, trigger, value]);

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
    if (choices.length > 0) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        setActiveIndex((index) => event.key === "ArrowDown" ? Math.min(index + 1, choices.length - 1) : Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        const agent = choices[activeIndex];
        if (agent) selectAgent(agent);
        return;
      }
    }
    onKeyDown(event);
  };

  const syncScroll = (element: HTMLTextAreaElement) => {
    if (!mirrorRef.current) return;
    mirrorRef.current.scrollTop = element.scrollTop;
    mirrorRef.current.scrollLeft = element.scrollLeft;
  };

  return (
    <>
      {choices.length > 0 && (
        <div ref={menuRef} id={listboxId} role="listbox" aria-label="Subagents" className="ui-popover absolute bottom-full left-0 right-0 z-50 mb-1 max-h-56 overflow-y-auto rounded-card p-1">
          {choices.map((agent, index) => (
            <button
              key={`${agent.source ?? "agent"}-${agent.name}`}
              ref={(element) => { optionRefs.current[index] = element; }}
              type="button"
              role="option"
              id={`${listboxId}-option-${index}`}
              aria-selected={index === activeIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectAgent(agent)}
              className={cn("flex w-full min-w-0 items-center gap-2 rounded-input px-2 py-1.5 text-left text-xs", index === activeIndex ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2")}
            >
              <span className="shrink-0 rounded bg-accent/10 px-1 font-mono text-accent">@{agent.name}</span>
              {agent.source && <span className="shrink-0 text-[10px] text-muted/70">{agent.source}</span>}
              <span className="min-w-0 flex-1 truncate">{agent.description}</span>
            </button>
          ))}
        </div>
      )}
      <div className="relative max-h-[160px] min-h-[64px] overflow-hidden">
        <div
          ref={mirrorRef}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-3 py-2 text-sm leading-6 text-text"
        >
          {renderHighlighted(value, mentions)}
          {value.endsWith("\n") ? "\n" : null}
        </div>
        <textarea
          ref={inputRef}
          value={value}
          role="combobox"
          aria-label="Message"
          aria-expanded={choices.length > 0}
          aria-controls={choices.length > 0 ? listboxId : undefined}
          aria-activedescendant={choices.length > 0 ? `${listboxId}-option-${activeIndex}` : undefined}
          aria-autocomplete="list"
          onChange={(event) => handleChange(event.target.value)}
          onSelect={(event) => handleSelect(event.currentTarget)}
          onKeyDown={handleKey}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onScroll={(event) => syncScroll(event.currentTarget)}
          placeholder={placeholder}
          rows={2}
          className="relative z-10 max-h-[160px] min-h-[64px] w-full resize-none bg-transparent px-3 py-2 text-sm leading-6 text-transparent caret-text outline-none placeholder:text-muted selection:bg-accent/25"
        />
      </div>
    </>
  );
}
