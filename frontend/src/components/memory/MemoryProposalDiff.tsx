import type { MemoryContent } from "@pi-science/contracts";
import { useTranslation } from "react-i18next";
import type { MemoryCategory } from "./memory-ui";
import { MemorySources } from "./MemorySources";
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
export function changedMemoryFields(
  current: MemoryContent & { status?: string },
  candidate: MemoryContent & { status?: string },
) {
  return fields.filter(
    (f) => JSON.stringify(current[f]) !== JSON.stringify(candidate[f]),
  );
}
/** A bounded contiguous edit marker. Exact full text is always retained. */
function EditText({
  value,
  other,
  after,
}: {
  value: string;
  other: string;
  after: boolean;
}) {
  const parts = (text: string) =>
    text.match(/\s+|[\p{Script=Han}]|[^\s\p{Script=Han}]+/gu) ?? [];
  const a = parts(value),
    b = parts(other);
  let prefix = 0,
    suffix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix])
    prefix++;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const middle = a.slice(prefix, a.length - suffix).join("");
  return (
    <>
      {a.slice(0, prefix).join("")}
      {middle &&
        (after ? (
          <ins className="rounded bg-ok-fill/15 px-0.5 text-ok-text no-underline">
            {middle}
          </ins>
        ) : (
          <del className="rounded bg-error-fill/10 px-0.5 text-error-text">
            {middle}
          </del>
        ))}
      {suffix ? a.slice(a.length - suffix).join("") : ""}
    </>
  );
}
export function MemoryProposalDiff({
  current,
  candidate,
  categories = [],
  cwd,
  onOpenSource,
}: {
  current?: MemoryContent & { status?: string };
  candidate: MemoryContent & { status?: string };
  categories?: MemoryCategory[];
  cwd?: string;
  onOpenSource?: () => void;
}) {
  const { t } = useTranslation();
  if (!current)
    return (
      <p role="alert" className="text-ui-label text-error-text">
        {t("memory.currentVersionUnavailable")}
      </p>
    );
  const changed = changedMemoryFields(current, candidate);
  const unchanged = fields.filter(
    (f) =>
      !changed.includes(f) && current[f] !== undefined && current[f] !== "",
  );
  const label = (field: (typeof fields)[number]) =>
    t(
      field === "title"
        ? "memory.recordTitle"
        : field === "sources"
          ? "memory.sourceReferences"
          : field === "categoryId"
            ? "memory.filter.categoryId"
            : `memory.${field}`,
    );
  const sourceProjectChanged =
    current.sources.some(
      (source, index) =>
        source.projectId !== candidate.sources[index]?.projectId,
    ) ||
    candidate.sources.some(
      (source, index) => source.projectId !== current.sources[index]?.projectId,
    );
  const value = (
    field: (typeof fields)[number],
    item: typeof candidate,
    other: typeof candidate,
    after: boolean,
  ) => {
    const raw = item[field];
    if (raw === undefined || raw === "")
      return <span className="text-muted">—</span>;
    if (field === "sources")
      return (
        <MemorySources
          sources={item.sources}
          showProject={sourceProjectChanged}
          cwd={cwd}
          projectId={(item as { projectId?: string }).projectId}
          onOpen={onOpenSource}
        />
      );
    if (field === "body" && changed.includes("body"))
      return <EditText value={item.body} other={other.body} after={after} />;
    if (field === "categoryId")
      return categories.find((c) => c.id === raw)?.name ?? String(raw);
    if (["scope", "kind", "status", "evidenceLevel"].includes(field))
      return t(
        `memory.${field === "scope" ? "scopeLabel" : field === "kind" ? "kindLabel" : field === "status" ? "statusLabel" : "evidenceLabel"}.${raw}`,
        { defaultValue: String(raw) },
      );
    return String(raw);
  };
  const sourceHashChanged =
    current.sources.some(
      (source, index) => source.digest !== candidate.sources[index]?.digest,
    ) ||
    candidate.sources.some(
      (source, index) => source.digest !== current.sources[index]?.digest,
    );
  const sourceVersionChanged =
    current.sources.some(
      (source, index) => source.version !== candidate.sources[index]?.version,
    ) ||
    candidate.sources.some(
      (source, index) => source.version !== current.sources[index]?.version,
    );
  const row = (field: (typeof fields)[number], isChanged: boolean) => (
    <section key={field} className="border-b border-faint py-4 last:border-0">
      <h4 className="mb-2 flex items-center gap-2 text-ui-label font-medium">
        {label(field)}
        {isChanged && (
          <span className="rounded bg-accent-soft px-1.5 py-0.5 text-ui-caption text-accent">
            {t("memory.changed")}
          </span>
        )}
      </h4>
      {field === "sources" && isChanged && (
        <p className="mb-3 text-ui-caption text-accent">
          {[
            sourceProjectChanged ? t("memory.sourceProjectChanged") : null,
            sourceVersionChanged ? t("memory.sourceVersionChanged") : null,
            sourceHashChanged ? t("memory.sourceHashChanged") : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
      <div className="grid grid-cols-2 gap-5">
        {[current, candidate].map((item, index) => (
          <div
            key={index}
            className="min-w-0 whitespace-pre-wrap break-words text-ui-label leading-6"
          >
            {value(field, item, index === 0 ? candidate : current, index === 1)}
          </div>
        ))}
      </div>
    </section>
  );
  return (
    <div>
      <div className="sticky top-0 z-10 grid grid-cols-2 gap-5 border-b border-faint bg-surface-raised py-3 text-ui-label font-semibold">
        <h3>{t("memory.before")}</h3>
        <h3 className="text-accent">{t("memory.after")}</h3>
      </div>
      {changed.length ? (
        changed.map((f) => row(f, true))
      ) : (
        <p className="py-4 text-ui-caption text-muted">
          {t("memory.noContentChanges")}
        </p>
      )}
      {unchanged.length > 0 && (
        <details className="mt-4 rounded-card border border-faint bg-surface-2/40 px-4">
          <summary className="cursor-pointer py-3 text-ui-caption text-muted">
            {t("memory.unchangedFields", { count: unchanged.length })}
          </summary>
          {unchanged.map((f) => row(f, false))}
        </details>
      )}
      <details className="mt-4 border-t border-faint pt-3">
        <summary className="cursor-pointer text-ui-caption text-muted">
          {t("memory.rawComparison")}
        </summary>
        <pre className="mt-3 whitespace-pre-wrap break-all text-ui-caption text-muted">
          {JSON.stringify({ current, candidate }, null, 2)}
        </pre>
      </details>
    </div>
  );
}
