import { FlaskConical } from "lucide-react";
import { cn } from "../../lib/ui";
import { useTranslation } from "react-i18next";

export type ResearchStarter = "research_loop" | "optimize" | "compare" | "evaluate" | "reproduce";

const modes: ResearchStarter[] = ["research_loop", "optimize", "compare", "evaluate", "reproduce"];

export function ResearchModePicker({ selected, disabled, onSelect, className }: { selected: ResearchStarter | null; disabled?: boolean; onSelect: (mode: ResearchStarter, prompt: string) => void; className?: string }) {
  const { t } = useTranslation();
  return <div className={cn("flex flex-wrap gap-2 px-1 pb-1", className)} aria-label={t("research.conversationMode")}>{modes.map((mode) => <button key={mode} type="button" disabled={disabled} aria-pressed={selected === mode} onClick={() => onSelect(mode, t(`research.mode.${mode}.prompt`))} className={cn("flex h-7 min-h-0 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors disabled:opacity-50", selected === mode ? "border-accent bg-accent-fill text-accent-fg" : "border-border bg-surface text-muted hover:text-text")}><FlaskConical size={13} /> {t(`research.mode.${mode}.label`)}</button>)}</div>;
}

