import type { MemoryRecord } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";
import { MemorySources } from "./MemorySources";
import type { MemoryCategory } from "./memory-ui";
/** Candidate content remains entirely inspectable before exact-version approval. */
export function MemoryReviewRecord({
  record: r,
  categories,
  cwd,
  onOpenSource,
}: {
  record: MemoryRecord;
  categories: MemoryCategory[];
  cwd: string;
  onOpenSource: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap gap-3 text-ui-caption text-muted">
        <span>{t("memory.version", { version: r.revision })}</span>
        <span>{t(`memory.statusLabel.${r.status}`)}</span>
        <span>
          {t(`memory.originLabel.${r.origin}`, { defaultValue: r.origin })}
        </span>
      </div>
      <section className="space-y-3">
        <h3 className="text-ui-label font-semibold">{t("memory.body")}</h3>
        <p className="whitespace-pre-wrap break-words text-ui-body leading-7">
          {r.body}
        </p>
      </section>
      <dl className="grid grid-cols-2 gap-4 rounded-card border border-faint bg-surface-2/40 p-4 text-ui-label">
        {[
          [t("memory.scope"), t(`memory.scopeLabel.${r.scope}`)],
          [t("memory.kind"), t(`memory.kindLabel.${r.kind}`)],
          [
            t("memory.filter.categoryId"),
            categories.find((c) => c.id === r.categoryId)?.name ??
              t(
                r.categoryId
                  ? "memory.unavailableCategory"
                  : "memory.noCategory",
              ),
          ],
          [
            t("memory.evidenceLevel"),
            t(`memory.evidenceLabel.${r.evidenceLevel}`),
          ],
          ...(r.artifactId ? [[t("memory.artifactId"), r.artifactId]] : []),
          ...(r.artifactVersionId
            ? [[t("memory.artifactVersionId"), r.artifactVersionId]]
            : []),
          ...(r.subjectFrameId
            ? [[t("memory.subjectFrameId"), r.subjectFrameId]]
            : []),
        ].map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-ui-caption text-muted">{label}</dt>
            <dd className="mt-1 break-all">{value}</dd>
          </div>
        ))}
      </dl>
      <section className="space-y-3 border-t border-faint pt-5">
        <h3 className="text-ui-label font-semibold">
          {t("memory.sourceReferences")}
        </h3>
        <MemorySources
          sources={r.sources}
          cwd={cwd}
          projectId={r.projectId}
          onOpen={onOpenSource}
        />
      </section>
      <details className="border-t border-faint pt-3">
        <summary className="cursor-pointer text-ui-caption text-muted">
          {t("memory.advancedData")}
        </summary>
        <pre className="mt-3 whitespace-pre-wrap break-all text-ui-caption text-muted">
          {JSON.stringify(r, null, 2)}
        </pre>
      </details>
    </div>
  );
}
