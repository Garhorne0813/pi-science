import { useEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown, Search } from "lucide-react";
import { cn } from "../../lib/ui";

export interface SettingsSelectOption {
  value: string;
  label: string;
  hint?: string;
}

type SettingsSelectVariant = "row" | "field" | "compact";

/** The settings dialog overlay sits at z-[95]; the portal menu must render
 *  above it, so the popover keeps a higher layer than any in-dialog surface.
 *  The height is capped by the viewport (Radix exposes the space it measured
 *  as `--radix-dropdown-menu-content-available-height`), so long lists scroll
 *  inside the menu instead of overflowing the screen. */
const MENU_CONTENT_CLASS =
  "ui-popover z-[110] min-w-[13rem] max-w-[min(20rem,calc(100vw-16px))] max-h-[min(22rem,var(--radix-dropdown-menu-content-available-height))] rounded-card p-1.5 text-ui-label text-text outline-none " +
  "data-[state=open]:animate-[settings-menu-in_160ms_var(--ease-standard)] data-[state=closed]:animate-[settings-menu-out_100ms_var(--ease-standard)]";
const MENU_ITEM_CLASS =
  "flex min-h-9 cursor-default select-none items-center gap-2 rounded-input px-2.5 py-2 text-ui-label text-text outline-none transition-colors data-[highlighted]:bg-surface-hover data-[disabled]:opacity-40";

const TRIGGER_BASE =
  "group flex min-w-0 items-center gap-1.5 rounded-input text-text outline-none transition-colors disabled:cursor-not-allowed disabled:text-muted disabled:opacity-70";
const TRIGGER_ROW =
  "h-9 max-w-[62%] shrink-0 px-2.5 text-sm hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/25 data-[state=open]:bg-surface-2";
const TRIGGER_FIELD =
  "h-10 w-full border border-border bg-surface-2 px-3 text-xs hover:border-accent focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/25 data-[state=open]:border-accent";
const TRIGGER_COMPACT =
  "h-8 w-auto min-w-[7rem] border border-border bg-surface-2 px-2 text-xs hover:border-accent focus-visible:border-accent focus-visible:ring-1 focus-visible:ring-accent/25 data-[state=open]:border-accent";
const TRIGGER_CLASSES: Record<SettingsSelectVariant, string> = {
  row: TRIGGER_ROW,
  field: TRIGGER_FIELD,
  compact: TRIGGER_COMPACT,
};

/** Settings dropdown (Radix). Replaces the native browser select everywhere
 *  in the settings page so the closed state and the open menu share the app's
 *  DeepSeek-inspired language. `row` renders the transparent hover-surfaced
 *  trigger used on the right side of a settings row; `field` renders the
 *  bordered full-width trigger used inside forms; `compact` renders a small
 *  bordered inline trigger. `searchable` pins a filter box to the top of the
 *  menu and scrolls only the option list below it. */
export function SettingsSelectMenu({
  value,
  options,
  onSelect,
  ariaLabel,
  placeholder,
  disabled = false,
  variant = "row",
  align,
  autoFocus = false,
  searchable = false,
  searchPlaceholder,
  emptyMessage,
  className,
  contentClassName,
}: {
  value: string;
  options: SettingsSelectOption[];
  onSelect: (value: string) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  variant?: SettingsSelectVariant;
  align?: "start" | "center" | "end";
  autoFocus?: boolean;
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyMessage?: string;
  className?: string;
  contentClassName?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const selected = options.find((option) => option.value === value);
  const display = selected?.label ?? placeholder ?? value;
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = normalizedQuery
    ? options.filter((option) =>
        option.label.toLowerCase().includes(normalizedQuery) ||
        option.value.toLowerCase().includes(normalizedQuery) ||
        (option.hint ?? "").toLowerCase().includes(normalizedQuery),
      )
    : options;
  // Radix focuses the menu content itself when it opens; wait a couple of
  // frames so the search box can steal focus after that pass completes.
  useEffect(() => {
    if (!(open && searchable)) return;
    let cancelled = false;
    const focus = () => { if (!cancelled) searchRef.current?.focus(); };
    const frame = requestAnimationFrame(() => requestAnimationFrame(focus));
    return () => { cancelled = true; cancelAnimationFrame(frame); };
  }, [open, searchable]);

  return (
    <DropdownMenu.Root onOpenChange={(next) => { setOpen(next); if (!next) setQuery(""); }}>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`${ariaLabel}: ${display}`}
          disabled={disabled}
          autoFocus={autoFocus}
          className={cn(TRIGGER_BASE, TRIGGER_CLASSES[variant], className)}
        >
          <span className="min-w-0 flex-1 truncate">{display}</span>
          <ChevronDown size={14} className="shrink-0 text-muted transition-transform duration-fast group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align={align ?? (variant === "row" ? "end" : "start")}
          sideOffset={6}
          collisionPadding={8}
          className={cn(
            MENU_CONTENT_CLASS,
            searchable ? "overflow-hidden" : "overflow-y-auto overscroll-contain",
            variant !== "row" && "min-w-0 w-[var(--radix-dropdown-menu-trigger-width)]",
            contentClassName,
          )}
        >
          {searchable && (
            <div className="mb-1.5 border-b border-faint pb-2">
              <div className="flex h-9 items-center gap-2 rounded-input bg-surface-2 px-2.5">
                <Search size={13} className="shrink-0 text-muted" />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={searchPlaceholder}
                  aria-label={searchPlaceholder}
                  className="min-w-0 flex-1 bg-transparent text-ui-label text-text outline-none placeholder:text-muted"
                  onKeyDown={(event) => {
                    // Printable keys must not reach Radix's menu typeahead;
                    // Escape and arrow keys still bubble to the menu.
                    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
                  }}
                />
              </div>
            </div>
          )}
          <div className={searchable ? "max-h-[min(16rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto overscroll-contain" : undefined}>
            <DropdownMenu.RadioGroup value={value} onValueChange={onSelect}>
              {visibleOptions.map((option) => (
                <DropdownMenu.RadioItem
                  key={option.value}
                  value={option.value}
                  className={cn(MENU_ITEM_CLASS, option.value === value && "bg-accent-soft")}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {option.hint && <span aria-hidden="true" className="max-w-[9rem] shrink-0 truncate font-mono text-ui-caption text-muted">{option.hint}</span>}
                  <DropdownMenu.ItemIndicator>
                    <Check size={14} className="shrink-0 text-accent" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
            {visibleOptions.length === 0 && (
              <p className="px-2.5 py-4 text-center text-ui-caption text-muted">{emptyMessage}</p>
            )}
          </div>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
