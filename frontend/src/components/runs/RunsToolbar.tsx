import { useEffect, useRef, useState } from "react";
import { Search, SlidersHorizontal, CalendarDays, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ExecutionRecord } from "@pi-science/contracts";

export const RUN_KINDS: ExecutionRecord["kind"][] = ["tool", "kernel_cell", "job", "research_agent", "research_evaluation"];
export const RUN_STATUSES: ExecutionRecord["status"][] = ["pending", "running", "succeeded", "failed", "timed_out", "cancelled", "interrupted", "lost"];

export function localDatetime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface Props {
  search: string; kind: string; status: string; from: string; to: string;
  onChange: (changes: Record<string, string | null>, replace?: boolean) => void;
  onClear: () => void;
}
const inputClass = "min-h-10 w-full rounded-input border border-border bg-surface px-3 text-sm text-text focus:border-accent";

export function RunsToolbar({ search, kind, status, from, to, onChange, onClear }: Props) {
  const { t } = useTranslation();
  const [searchDraft, setSearchDraft] = useState(search);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    clearTimeout(searchTimer.current);
    setSearchDraft(search);
  }, [search]);
  useEffect(() => () => clearTimeout(searchTimer.current), []);
  const editSearch = (value: string) => {
    setSearchDraft(value);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => onChangeRef.current({ search: value || null }, true), 300);
  };
  const clear = () => {
    clearTimeout(searchTimer.current);
    setSearchDraft("");
    onClear();
  };
  const filters = Number(Boolean(kind)) + Number(Boolean(status));
  const active = Boolean(filters || from || to || searchDraft);
  const changeDate = (key: string, value: string) => onChange({ [key]: value ? new Date(value).toISOString() : null });
  return <div className="relative z-10 mt-4 flex flex-wrap items-center gap-2">
    <label className="relative min-w-0 flex-[1_1_220px]">
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
      <input aria-label={t("runs.search")} value={searchDraft} placeholder={t("runs.searchPlaceholder")} onChange={(e) => editSearch(e.target.value)} className={`${inputClass} pl-10`} />
    </label>
    <details className="relative" onKeyDown={(e) => { if (e.key === "Escape") { e.currentTarget.open = false; e.currentTarget.querySelector("summary")?.focus(); } }}>
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-input border border-border bg-surface px-3 text-sm text-text"><CalendarDays size={16} />{t("runs.timeWindow")}{(from || to) && <span className="h-2 w-2 rounded-full bg-accent" />}</summary>
      <div className="absolute right-0 top-full mt-2 w-[min(320px,80vw)] space-y-3 rounded-card border border-border bg-surface p-4 shadow-lg">
        <p className="text-xs leading-5 text-muted">{t("runs.timeWindowHint")}</p>
        <label className="block text-sm text-text">{t("runs.from")}<input aria-label={t("runs.from")} type="datetime-local" value={localDatetime(from)} onChange={(e) => changeDate("from", e.target.value)} className={`${inputClass} mt-1`} /></label>
        <label className="block text-sm text-text">{t("runs.to")}<input aria-label={t("runs.to")} type="datetime-local" value={localDatetime(to)} onChange={(e) => changeDate("to", e.target.value)} className={`${inputClass} mt-1`} /></label>
      </div>
    </details>
    <details className="relative" onKeyDown={(e) => { if (e.key === "Escape") { e.currentTarget.open = false; e.currentTarget.querySelector("summary")?.focus(); } }}>
      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-input border border-border bg-surface px-3 text-sm text-text"><SlidersHorizontal size={16} />{t("runs.filters")}{filters > 0 && <span className="rounded bg-surface-2 px-1.5 text-xs">{filters}</span>}</summary>
      <div className="absolute right-0 top-full mt-2 w-[min(260px,80vw)] space-y-3 rounded-card border border-border bg-surface p-4 shadow-lg">
        <label className="block text-sm text-text">{t("runs.kindFilter")}<select aria-label={t("runs.kindFilter")} value={kind || "all"} onChange={(e) => onChange({ kind: e.target.value === "all" ? null : e.target.value })} className={`${inputClass} mt-1`}><option value="all">{t("runs.allKinds")}</option>{RUN_KINDS.map((value) => <option key={value} value={value}>{t(`runs.kind.${value}`)}</option>)}</select></label>
        <label className="block text-sm text-text">{t("runs.statusFilter")}<select aria-label={t("runs.statusFilter")} value={status || "all"} onChange={(e) => onChange({ status: e.target.value === "all" ? null : e.target.value })} className={`${inputClass} mt-1`}><option value="all">{t("runs.allStatuses")}</option>{RUN_STATUSES.map((value) => <option key={value} value={value}>{t(`runs.status.${value}`)}</option>)}</select></label>
      </div>
    </details>
    {active && <button type="button" onClick={clear} className="flex min-h-10 items-center gap-1.5 px-2 text-sm text-muted hover:text-text"><X size={14} />{t("runs.clearFilters")}</button>}
    {(kind || status || from || to) && <p className="basis-full text-xs text-muted" aria-live="polite">{[kind && t(`runs.kind.${kind}`), status && t(`runs.status.${status}`), from && `${t("runs.from")} ${new Date(from).toLocaleString()}`, to && `${t("runs.to")} ${new Date(to).toLocaleString()}`].filter(Boolean).join(" · ")}</p>}
  </div>;
}
