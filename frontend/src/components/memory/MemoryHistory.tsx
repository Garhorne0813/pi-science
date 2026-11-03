import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { MemoryRecord } from "@pi-science/contracts";
import { MemoryProposalDiff } from "./MemoryProposalDiff";
import { MemorySources } from "./MemorySources";
import { memoryButton, type MemoryCategory } from "./memory-ui";
export type MemoryHistoryData = {
  revisions: MemoryRecord[];
  reviews: Array<{
    action: string;
    actor: string;
    created_at: number;
    revision: number;
    content_hash?: string;
  }>;
};
export function MemoryHistory({
  data,
  current,
  categories,
  cwd,
  onOpenSource,
}: {
  data: MemoryHistoryData;
  current: MemoryRecord;
  categories: MemoryCategory[];
  cwd: string;
  onOpenSource?: () => void;
}) {
  const { t } = useTranslation();
  const versions = [...(data.revisions ?? [])].sort(
    (a, b) => b.revision - a.revision,
  );
  const [selected, set] = useState(versions[0]?.revision);
  const [compare, setCompare] = useState(false);
  const r = versions.find((v) => v.revision === selected);
  const previous = versions.find((v) => v.revision === (r?.revision ?? 0) - 1);
  const exportJson = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = `memory-${current.id}-history.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="grid h-[min(70vh,680px)] min-h-0 grid-cols-[220px_minmax(0,1fr)]">
      <aside
        aria-label={t("memory.historyVersions")}
        className="overflow-y-auto border-r border-faint bg-surface-2/40 p-3"
      >
        <ol className="space-y-2">
          {versions.map((v) => (
            <li key={v.revision}>
              <button
                type="button"
                aria-pressed={selected === v.revision}
                className={`w-full rounded-input border px-3 py-3 text-left text-ui-label ${selected === v.revision ? "border-accent/30 bg-accent-soft" : "border-transparent hover:bg-surface-hover"}`}
                onClick={() => {
                  set(v.revision);
                  setCompare(false);
                }}
              >
                <span className="block font-medium">
                  {t("memory.version", { version: v.revision })}
                </span>
                <time className="mt-1 block text-ui-caption text-muted">
                  {new Date(v.updatedAt).toLocaleString()}
                </time>
                {v.revision === current.revision && (
                  <span className="mt-2 inline-block text-ui-caption text-accent">
                    {t("memory.currentVersion")}
                  </span>
                )}
                <span className="mt-1 block text-ui-caption text-muted">
                  {t(`memory.originLabel.${v.origin}`, {
                    defaultValue: v.origin,
                  })}
                </span>
              </button>
            </li>
          ))}
        </ol>
      </aside>
      <div className="min-w-0 space-y-5 overflow-y-auto p-5">
        {r ? (
          <>
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-ui-body font-semibold">{r.title}</h3>
                <p className="mt-1 text-ui-caption text-muted">
                  {t("memory.version", { version: r.revision })} ·{" "}
                  {r.revision === current.revision
                    ? t(`memory.statusLabel.${current.status}`)
                    : t("memory.historicalVersion")}
                </p>
              </div>
              {previous && (
                <button
                  type="button"
                  className={memoryButton}
                  aria-pressed={compare}
                  onClick={() => setCompare(!compare)}
                >
                  {t(compare ? "memory.showVersion" : "memory.comparePrevious")}
                </button>
              )}
            </div>
            {compare && previous ? (
              <MemoryProposalDiff
                current={previous}
                candidate={r}
                categories={categories}
                cwd={cwd}
                onOpenSource={onOpenSource}
              />
            ) : (
              <>
                <p className="whitespace-pre-wrap break-words text-ui-label leading-6">
                  {r.body}
                </p>
                <dl className="grid grid-cols-2 gap-3 rounded-card bg-surface-2/40 p-4 text-ui-caption">
                  <div>
                    <dt className="text-muted">{t("memory.kind")}</dt>
                    <dd>{t(`memory.kindLabel.${r.kind}`)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">{t("memory.evidenceLevel")}</dt>
                    <dd>{t(`memory.evidenceLabel.${r.evidenceLevel}`)}</dd>
                  </div>
                </dl>
                <MemorySources
                  sources={r.sources}
                  cwd={cwd}
                  projectId={r.projectId}
                  onOpen={onOpenSource}
                />
              </>
            )}
            <section className="space-y-2 border-t border-faint pt-4">
              <h4 className="text-ui-label font-medium">
                {t("memory.reviewEvents")}
              </h4>
              {data.reviews
                .filter((e) => e.revision === r.revision)
                .map((event, index) => (
                  <p key={index} className="text-ui-caption text-muted">
                    {new Date(event.created_at).toLocaleString()} ·{" "}
                    {event.actor === "local-owner"
                      ? t("memory.localOwner")
                      : event.actor}{" "}
                    ·{" "}
                    {t(
                      event.action.startsWith("approve")
                        ? "memory.eventApproved"
                        : event.action.startsWith("reject")
                          ? "memory.eventRejected"
                          : "memory.eventChanged",
                    )}
                  </p>
                ))}
            </section>
          </>
        ) : (
          <p className="text-ui-label text-muted">{t("memory.emptyHistory")}</p>
        )}
        <details className="border-t border-faint pt-4">
          <summary className="cursor-pointer text-ui-caption text-muted">
            {t("memory.advancedData")}
          </summary>
          <button
            type="button"
            className={memoryButton + " my-3"}
            onClick={exportJson}
          >
            {t("memory.export")}
          </button>
          <pre className="whitespace-pre-wrap break-all text-ui-caption text-muted">
            {JSON.stringify(data, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}
