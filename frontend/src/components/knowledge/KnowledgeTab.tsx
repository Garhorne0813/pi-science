import { FileText } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";
import { groupKnowledgeItems, KNOWLEDGE_LABELS, type KnowledgeItem } from "../../lib/knowledge";
import { EmptyState } from "./EmptyState";

export function KnowledgeTab({ items }: { items: KnowledgeItem[] }) {
  const { t } = useTranslation();
  const groups = groupKnowledgeItems(items);
  if (items.length === 0) return <EmptyState icon={<FileText size={28} />} title={t("knowledge.noKnowledge")} text={t("knowledge.noKnowledgeText")} />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {Object.entries(groups).map(([type, rows]) => (
        <section key={type} className="ui-card-flat rounded-card p-4">
          <div className="flex items-center justify-between border-b border-faint pb-3">
            <h2 className="text-lg font-semibold text-text">{KNOWLEDGE_LABELS[type as keyof typeof KNOWLEDGE_LABELS]}</h2>
            <span className="font-mono text-xs text-muted">{rows.length}</span>
          </div>
          <div className="divide-y divide-faint">
            {rows.map((item) => (
              <article key={item.id} className={cn("py-4", item.status !== "active" && "opacity-55")}>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-text">{item.title}</h3>
                  <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-muted">{item.status}</span>
                </div>
                <p className="mt-1.5 text-sm leading-6 text-muted">{item.summary}</p>
                <div className="mt-2 font-mono text-[10px] text-muted">{item.id} · {item.confidence}</div>
              </article>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
