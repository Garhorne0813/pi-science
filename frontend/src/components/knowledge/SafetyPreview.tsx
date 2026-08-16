import { useTranslation } from "react-i18next";
import { cn } from "../../lib/ui";

export function SafetyPreview({ data }: { data: Record<string, unknown> }) {
  const { t } = useTranslation();
  const collisions = Array.isArray(data.collisions) ? data.collisions as string[] : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings as string[] : [];
  const referenceCount = typeof data.reference_count === "number" ? data.reference_count : 0;
  return (
    <div className={cn("rounded-input border px-3 py-3", collisions.length ? "border-error/30 bg-error/5" : "border-ok/30 bg-ok/5")}>
      <div className="font-medium text-text">{collisions.length ? t("knowledge.safetyBlockers") : t("knowledge.safetyPassed")}</div>
      <div className="mt-1">{t("knowledge.safetyReferences", { count: referenceCount })}</div>
      {collisions.map((value) => <div key={value} className="mt-1 text-error-text">• {value}</div>)}
      {warnings.map((value) => <div key={value} className="mt-1 text-warn-text">• {value}</div>)}
    </div>
  );
}
