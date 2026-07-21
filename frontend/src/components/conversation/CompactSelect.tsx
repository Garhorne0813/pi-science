import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "../../lib/cn";

export interface CompactSelectOption {
  value: string;
  label: string;
}

export function CompactSelect({ label, prefix, value, options, disabled = false, className, onChange }: {
  label: string;
  prefix?: string;
  value: string;
  options: CompactSelectOption[];
  disabled?: boolean;
  className?: string;
  onChange: (value: string) => void;
}) {
  const selected = options.find((option) => option.value === value) || options[0];
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button type="button" aria-label={label} className={cn("group flex min-h-7 min-w-0 items-center gap-1.5 rounded-input bg-surface px-2.5 py-1 text-[11px] text-text outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50", className)}>
          {prefix && <span className="shrink-0 text-muted">{prefix}</span>}
          <span className="min-w-0 flex-1 truncate text-left">{selected?.label || value}</span>
          <ChevronDown size={12} className="shrink-0 text-muted transition-transform duration-150 group-data-[state=open]:rotate-180" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={5} collisionPadding={8} className="z-[90] max-h-64 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto rounded-input bg-surface p-1 shadow-pop ring-1 ring-black/5 dark:ring-white/10">
          {options.map((option) => (
            <DropdownMenu.Item key={option.value} onSelect={() => onChange(option.value)} className="flex min-h-8 cursor-default select-none items-center gap-2 rounded-input px-2 py-1.5 text-[11px] text-text outline-none transition-colors data-[highlighted]:bg-surface-2">
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {option.value === value && <Check size={12} className="shrink-0 text-accent" />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
