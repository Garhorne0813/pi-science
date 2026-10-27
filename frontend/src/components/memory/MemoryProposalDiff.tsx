import type { MemoryContent } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";

const fields = [
  "title",
  "body",
  "scope",
  "kind",
  "artifactId",
  "artifactVersionId",
  "subjectFrameId",
  "categoryId",
  "evidenceLevel",
  "sources",
  "status",
] as const;
export function MemoryProposalDiff({
  current,
  candidate,
}: {
  current?: MemoryContent & { status?: string };
  candidate: MemoryContent & { status?: string };
}) {
  const { t } = useTranslation();
  if (!current)
    return <p role="alert">{t("memory.currentVersionUnavailable")}</p>;
  const display = (value: unknown) =>
    value === undefined || value === ""
      ? "—"
      : typeof value === "string"
        ? value
        : JSON.stringify(value, null, 2);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 text-ui-caption font-semibold">
        <h3>{t("memory.before")}</h3>
        <h3>{t("memory.after")}</h3>
      </div>
      {fields.map((field) => {
        const changed =
          JSON.stringify(current[field]) !== JSON.stringify(candidate[field]);
        return (
          <section key={field} className="space-y-1">
            <h4 className="text-ui-caption font-medium">
              {t(field === "title" ? "memory.recordTitle" : `memory.${field}`)}
              {changed && (
                <span className="ml-2 text-accent">{t("memory.changed")}</span>
              )}
            </h4>
            <div className="grid grid-cols-2 gap-3">
              {[current[field], candidate[field]].map((value, index) => (
                <pre
                  key={index}
                  className={`min-w-0 whitespace-pre-wrap break-words rounded-input border border-faint p-2 text-ui-caption font-sans ${changed ? "bg-accent-soft" : "bg-surface-2/40"}`}
                >
                  {display(value)}
                </pre>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
