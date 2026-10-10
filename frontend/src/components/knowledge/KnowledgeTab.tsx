import { useMemo, useState } from "react";
import { FileText, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { KNOWLEDGE_LABELS, type KnowledgeItem, type KnowledgeType } from "../../lib/knowledge";
import { SourceEvidencePanel } from "./SourceEvidencePanel";
import { EmptyState } from "./EmptyState";

export function KnowledgeTab({ items, initialTypes = [] }: { items: KnowledgeItem[]; initialTypes?: KnowledgeType[] }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<KnowledgeType[]>(initialTypes);
  const [status, setStatus] = useState("active");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const filtered = useMemo(() => items.filter(item => (!types.length || types.includes(item.type)) && (status === "all" || item.status === status) && [item.title, item.summary, item.id, ...item.related_files].join(" ").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).sort((a, b) => b.updated_at.localeCompare(a.updated_at)), [items, types, status, query]);
  const selected = filtered.find(item => item.id === selectedId) ?? filtered[0];
  if (!items.length) return <EmptyState icon={<FileText size={28}/>} title={t("knowledge.noKnowledge")} text={t("knowledge.noKnowledgeText")}/>;
  return <div className="space-y-4">
    <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-3 sm:flex-row sm:flex-wrap sm:items-center">
      <label className="flex min-h-10 flex-1 sm:basis-full items-center gap-2 rounded-input border border-border bg-bg px-3"><Search size={16} className="text-muted"/><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t("knowledge.searchPlaceholder", { defaultValue: "搜索知识、摘要或关联文件…" })} className="min-w-0 flex-1 bg-transparent text-sm text-text outline-none" aria-label={t("knowledge.searchPlaceholder", { defaultValue: "搜索知识" })}/></label>
      <fieldset className="min-w-0 flex-1 flex flex-wrap items-center gap-2">
        <legend className="mb-1 text-xs text-muted">{t("knowledge.byType")}</legend>
        <button type="button" aria-pressed={!types.length} onClick={() => setTypes([])} className="rounded-input border border-border px-2 py-1 text-xs text-text">{t("knowledge.allTypes")}</button>
        {(Object.entries(KNOWLEDGE_LABELS) as [KnowledgeType, string][]).map(([value, label]) => <button type="button" key={value} aria-pressed={types.includes(value)} onClick={() => setTypes(current => current.includes(value) ? current.filter(type => type !== value) : [...current, value])} className={`rounded-input border px-2 py-1 text-xs text-text ${types.includes(value) ? "border-accent bg-accent/10" : "border-border"}`}>{label}</button>)}
      </fieldset>
      <select aria-label={t("knowledge.statusFilter", { defaultValue: "状态" })} value={status} onChange={event => setStatus(event.target.value)} className="min-h-10 rounded-input border border-border bg-bg px-3 text-sm text-text"><option value="active">{t("knowledge.activeOnly", { defaultValue: "当前有效" })}</option><option value="all">{t("knowledge.allStatuses", { defaultValue: "全部状态" })}</option><option value="superseded">{t("knowledge.superseded")}</option><option value="archived">{t("knowledge.archived")}</option></select>
    </div>
    <div className="grid min-h-[420px] gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,0.9fr)]">
      <section className="overflow-hidden rounded-card border border-border bg-surface">
        <div className="border-b border-faint px-4 py-3 text-xs text-muted">{filtered.length} {t("knowledge.knowledge")}</div>
        {filtered.length ? <div className="max-h-[680px] divide-y divide-faint overflow-y-auto">{filtered.map(item => <button type="button" key={item.id} onClick={() => setSelectedId(item.id)} aria-pressed={selected?.id === item.id} className={`w-full p-4 text-left transition-colors hover:bg-surface-2 ${selected?.id === item.id ? "bg-accent/5" : ""}`}><div className="flex flex-wrap items-center gap-2"><span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">{KNOWLEDGE_LABELS[item.type]}</span>{item.importance !== "normal" && <span className="text-[11px] text-accent">{item.importance}</span>}<span className="ml-auto text-[11px] text-muted">{item.confidence}</span></div><h3 className="mt-2 text-sm font-semibold text-text">{item.title}</h3><p className="mt-1 line-clamp-2 text-xs leading-5 text-muted">{item.summary}</p></button>)}</div> : <p className="p-8 text-center text-sm text-muted">{t("knowledge.noSearchResults", { defaultValue: "没有符合筛选条件的知识" })}</p>}
      </section>
      <aside className="min-w-0 rounded-card border border-border bg-surface p-5 lg:sticky lg:top-4 lg:self-start" aria-label={t("knowledge.details", { defaultValue: "知识详情" })}>
        {selected ? <div className="space-y-5"><div><span className="text-xs text-accent">{KNOWLEDGE_LABELS[selected.type]}</span><h2 className="mt-2 text-lg font-semibold text-text">{selected.title}</h2><p className="mt-3 whitespace-pre-wrap text-sm leading-7 text-muted">{selected.summary}</p></div><div className="grid grid-cols-2 gap-3 border-y border-faint py-4 text-xs"><div><div className="text-muted">{t("knowledge.confidence", { defaultValue: "可信度" })}</div><div className="mt-1 text-text">{selected.confidence}</div></div><div><div className="text-muted">{t("knowledge.statusFilter", { defaultValue: "状态" })}</div><div className="mt-1 text-text">{selected.status}</div></div><div><div className="text-muted">{t("knowledge.updatedAt", { defaultValue: "更新时间" })}</div><div className="mt-1 text-text">{new Date(selected.updated_at).toLocaleDateString()}</div></div><div><div className="text-muted">ID</div><div className="mt-1 break-all font-mono text-text">{selected.id}</div></div></div><div><h3 className="text-sm font-semibold text-text">{t("knowledge.relatedFiles")}</h3>{selected.related_files.length ? <div className="mt-2 space-y-2">{selected.related_files.map(file => <div key={file} className="break-all rounded-input bg-surface-2 p-2 font-mono text-xs text-muted">{file}</div>)}</div> : <p className="mt-2 text-xs text-muted">—</p>}</div><div><h3 className="text-sm font-semibold text-text">{t("knowledge.sourceEvidence", { defaultValue: "来源与证据" })}</h3><SourceEvidencePanel source={selected.source} /></div>{(selected.conflicts_with.length > 0 || selected.supersedes.length > 0) && <div className="text-xs text-muted">{selected.conflicts_with.length > 0 && <p>Conflicts: {selected.conflicts_with.join(", ")}</p>}{selected.supersedes.length > 0 && <p>Supersedes: {selected.supersedes.join(", ")}</p>}</div>}</div> : <div className="flex items-center justify-center py-16 text-sm text-muted">{t("knowledge.noSearchResults", { defaultValue: "请选择知识" })}</div>}
      </aside>
    </div>
  </div>;
}
