import { useTranslation } from "react-i18next";
import { memoryButton } from "./memory-ui";
export type MemoryRun = {
  id: string;
  kind: string;
  status: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  reviewMode: string;
  effectiveReviewMode?: string;
  tokens?: number;
  costUsd?: number;
  model?: string;
  actualModel?: string;
  error?: string;
  reason?: string;
  diagnostic?: {
    code: string;
    stage: string;
    failureCount: number;
    nextScanAt: number;
  };
  usage?: {
    measuredTokens: number;
    measuredCostUsd: number;
    estimatedTokens: number;
    estimatedCostUsd: number;
    reservedTokens: number;
    reservedCostUsd: number;
  };
  watermark?: number;
  sessionId?: string;
  messageIds?: string[];
  recordIds?: string[];
  reservedTokens?: number;
  windowStartLocalDate?: string;
  timeZone?: string;
  results?: unknown[];
};
export function MemoryRunCard({
  run: r,
  busy,
  stop,
  retry,
}: {
  run: MemoryRun;
  busy: boolean;
  stop: () => void;
  retry: () => void;
}) {
  const { t } = useTranslation();
  const cost = (v: number) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 6,
    }).format(v);
  const u = r.usage;
  const estimated = !!u && (u.estimatedTokens > 0 || u.estimatedCostUsd > 0);
  const reserved = !!u && (u.reservedTokens > 0 || u.reservedCostUsd > 0);
  const label = estimated
    ? "memory.usageEstimated"
    : reserved
      ? "memory.usageReserved"
      : "memory.usageMeasured";
  const amount = estimated
    ? u!.estimatedCostUsd
    : reserved
      ? u!.reservedCostUsd
      : (u?.measuredCostUsd ?? r.costUsd);
  const count = estimated
    ? u!.estimatedTokens
    : reserved
      ? u!.reservedTokens
      : (u?.measuredTokens ?? r.tokens);
  const duration =
    r.startedAt && r.endedAt
      ? Math.max(0, Math.round((r.endedAt - r.startedAt) / 1000))
      : undefined;
  return (
    <article
      data-run-id={r.id}
      className="relative rounded-card border border-faint bg-surface"
    >
      <details className="group">
        <summary className="grid cursor-pointer list-none grid-cols-1 sm:grid-cols-[minmax(140px,1fr)_1.2fr_80px_minmax(180px,1.2fr)] items-center gap-4 rounded-card px-4 py-4 pr-28 outline-none hover:bg-surface-2/40 focus-visible:ring-2 focus-visible:ring-accent/25 [&::-webkit-details-marker]:hidden">
          <span className="space-y-1">
            <span className="block text-ui-label font-medium">
              {t(
                r.kind === "extraction" ? "memory.extraction" : "memory.dream",
              )}
            </span>
            <span
              className={`inline-block rounded px-1.5 py-0.5 text-ui-caption ${r.status === "failed" ? "bg-error-fill/10 text-error-text" : r.status === "running" ? "bg-accent-soft text-accent" : "bg-surface-2 text-muted"}`}
            >
              {t(`memory.runStatus.${r.status}`, { defaultValue: r.status })}
            </span>
          </span>
          <time className="text-ui-caption text-muted">
            {new Date(r.startedAt ?? r.createdAt).toLocaleString()}
          </time>
          <span className="text-ui-caption text-muted">
            {duration === undefined
              ? "—"
              : t("memory.elapsedSeconds", { count: duration })}
          </span>
          <span className="text-ui-caption">
            <span className="block font-medium">
              {r.status === "skipped"
                ? t("memory.noModelCall")
                : amount === undefined
                  ? t("memory.usageUnavailable")
                  : t(label) + ": " + cost(amount)}
            </span>
            {count !== undefined && (
              <span className="mt-1 block text-muted">
                {count.toLocaleString()} tokens
              </span>
            )}
            <span className="mt-1 block text-link group-open:hidden">
              {t("memory.viewRunDetails")}
            </span>
          </span>
        </summary>
        <div className="space-y-3 border-t border-faint bg-surface-2/30 px-4 py-4 text-ui-caption text-muted">
          {(r.actualModel ?? r.model) ? (
            <p>
              {t("memory.runModel")}: {r.actualModel ?? r.model}
            </p>
          ) : null}
          {u && (
            <dl className="grid grid-cols-3 gap-3 rounded-input bg-surface p-3">
              {[
                ["memory.usageMeasured", u.measuredTokens, u.measuredCostUsd],
                [
                  "memory.usageEstimated",
                  u.estimatedTokens,
                  u.estimatedCostUsd,
                ],
                ["memory.usageReserved", u.reservedTokens, u.reservedCostUsd],
              ].map(([name, tokens, usd]) => (
                <div key={name}>
                  <dt>{t(String(name))}</dt>
                  <dd className="mt-1 text-text">
                    {tokens} tokens · {cost(Number(usd))}
                  </dd>
                </div>
              ))}
            </dl>
          )}
          {estimated && <p>{t("memory.usageEstimateHint")}</p>}
          {r.reason && (
            <p>
              {t("memory.skipped")}:{" "}
              {t(`memory.skipReason.${r.reason}`, { defaultValue: r.reason })}
            </p>
          )}
          {r.error && (
            <p
              className={
                r.status === "failed" ? "text-error-text" : "text-muted"
              }
            >
              {r.error}
            </p>
          )}
          {r.diagnostic && (
            <p>
              {t("memory.schedulerDiagnostic", {
                ...r.diagnostic,
                count: r.diagnostic.failureCount,
              })}
              {" · "}
              {t("memory.retryAt")}:{" "}
              {new Date(r.diagnostic.nextScanAt).toLocaleString()}
            </p>
          )}
          <p>
            {t("memory.readRange")}: {r.sessionId ?? r.recordIds?.length ?? 0} ·{" "}
            {r.watermark ?? r.messageIds?.length ?? 0}
          </p>
          {r.results && (
            <p>
              {t("memory.changes")}: {r.results.length}
            </p>
          )}
        </div>
      </details>
      {(["queued", "running"].includes(r.status) || r.status === "failed") && (
        <button
          disabled={busy}
          type="button"
          className={memoryButton + " absolute right-4 top-5"}
          onClick={r.status === "failed" ? retry : stop}
        >
          {t(r.status === "failed" ? "memory.retry" : "memory.stop")}
        </button>
      )}
    </article>
  );
}
