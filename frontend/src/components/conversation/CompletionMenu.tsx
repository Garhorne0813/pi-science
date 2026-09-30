import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { File, FolderOpen } from "lucide-react";
import type { RefObject } from "react";
import type { CompletionGroup, CompletionItem } from "../../lib/conversation/completion";
import { workspaceFiles } from "../../lib/workspace/workspace-files";

interface Props {
  /** The listbox element id. The composer textarea points aria-controls at it. */
  id: string;
  /** Translated accessible name for the listbox. */
  label: string;
  items: CompletionItem[];
  activeIndex: number;
  onSelect: (item: CompletionItem) => void;
  onActiveChange: (index: number) => void;
  onDismiss: () => void;
  /** The input this menu belongs to. A pointerdown inside it moves the caret, so it is not a dismissal. */
  inputRef?: RefObject<HTMLTextAreaElement | null>;
}

/** Adjacent rows that share one group value, with the index of the run's first row in `items`. */
function groupRuns(items: CompletionItem[]): Array<{ group: CompletionGroup | undefined; start: number; items: CompletionItem[] }> {
  const runs: Array<{ group: CompletionGroup | undefined; start: number; items: CompletionItem[] }> = [];
  items.forEach((item, index) => {
    const last = runs[runs.length - 1];
    if (last && last.group === item.group) last.items.push(item);
    else runs.push({ group: item.group, start: index, items: [item] });
  });
  return runs;
}

export function CompletionMenu({ id, label, items, activeIndex, onSelect, onActiveChange, onDismiss, inputRef }: Props) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    const active = rowRefs.current[activeIndex];
    if (active && typeof active.scrollIntoView === "function") active.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && inputRef?.current?.contains(target)) return;
      if (!(target instanceof Node) || !menuRef.current?.contains(target)) onDismiss();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [inputRef, onDismiss]);

  if (items.length === 0) return null;

  // The heading is translated here, so a language switch re-renders it and a provider never has to
  // reach into the i18n instance.
  const heading = (group: CompletionGroup | undefined) => (group === "agents" ? t("conversation.completion.groupAgents") : group === "files" ? t("conversation.completion.groupFiles") : undefined);
  const groups = new Set(items.map((item) => item.group).filter((group): group is CompletionGroup => group !== undefined));
  const runs = groupRuns(items);

  const renderRow = (item: CompletionItem, index: number) => (
    <button
      key={item.id}
      ref={(element) => { rowRefs.current[index] = element; }}
      type="button"
      role="option"
      id={`${id}-option-${index}`}
      aria-selected={index === activeIndex}
      // The combobox stays the only tab stop; Shift+Tab must not park focus on a row while
      // aria-activedescendant points somewhere else.
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={() => onActiveChange(index)}
      onClick={() => onSelect(item)}
      // tailwind-merge does not know the custom font-size names and treats text-ui-caption
      // as a color, dropping it when text-text/text-muted follows. Keep the size explicit.
      className={`flex min-w-0 w-full items-center gap-2 rounded-input px-2 py-1.5 text-left text-ui-caption ${index === activeIndex ? "bg-surface-2 text-text" : "text-muted hover:bg-surface-2"}`}
    >
      {item.kind === "directory" && <FolderOpen size={12} className="shrink-0 text-accent" />}
      {item.kind === "file" && <File size={12} className="shrink-0 text-accent" />}
      <span title={item.label} className="max-w-[55%] min-w-0 shrink-0 truncate rounded bg-accent-soft px-1 font-mono text-text sm:max-w-none">{item.label}</span>
      {item.description && <span className="min-w-0 flex-1 truncate" title={item.description}>{item.description}</span>}
      {item.detail && <span className="shrink-0 text-ui-meta text-muted">{item.detail}</span>}
      {item.payload?.kind === "reference" && <span className="shrink-0 text-ui-meta text-muted">{t("conversation.completion.reference")}</span>}
      {item.kind !== "directory" && item.size !== undefined && <span className="shrink-0 font-mono text-ui-meta text-muted">{workspaceFiles.formatSize(item.size)}</span>}
    </button>
  );

  return (
    <div ref={menuRef} role="listbox" id={id} aria-label={label} className="ui-popover absolute bottom-full left-0 right-0 z-50 mb-1 max-h-56 w-full max-w-full overflow-y-auto rounded-card p-1">
      <div id={`${id}-help`} className="sr-only">
        {t("conversation.completion.keyboardHint")}
      </div>
      {groups.size > 1
        ? runs.map((run) => (
            <div key={run.group ?? run.start} role="group" aria-label={heading(run.group)}>
              <div aria-hidden="true" className="px-2 pt-1.5 pb-0.5 text-ui-meta text-muted">{heading(run.group)}</div>
              {run.items.map((item, offset) => renderRow(item, run.start + offset))}
            </div>
          ))
        : items.map((item, index) => renderRow(item, index))}
    </div>
  );
}
