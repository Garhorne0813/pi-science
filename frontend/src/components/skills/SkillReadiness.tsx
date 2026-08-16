import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Copy, Loader2, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SkillReadiness } from "../../lib/skills/skills-api";

/** Compact per-skill readiness pill shown next to skill rows. */
export function SkillReadinessBadge({ readiness, loading, error }: { readiness?: SkillReadiness | null; loading?: boolean; error?: string | null }) {
  const { t } = useTranslation();
  if (error) {
    return (
      <span title={error} className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] text-muted ring-1 ring-border">
        <Wrench size={10} /> {t("skills.readinessError")}
      </span>
    );
  }
  if (loading && !readiness) {
    return <Loader2 size={13} className="shrink-0 animate-spin text-muted" aria-label={t("skills.readinessLoading")} />;
  }
  if (!readiness || readiness.requirements.length === 0) return null;
  if (readiness.ready) {
    return (
      <span title={t("skills.readinessReady")} className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] text-ok-text ring-1 ring-border" style={{ backgroundColor: "color-mix(in srgb, var(--ok) 10%, transparent)" }}>
        <Check size={10} /> {t("skills.ready")}
      </span>
    );
  }
  return (
    <span title={t("skills.readinessBlocked")} className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] text-error-text ring-1 ring-border" style={{ backgroundColor: "color-mix(in srgb, var(--error) 10%, transparent)" }}>
      <AlertTriangle size={10} /> {t("skills.needsDeps")}
    </span>
  );
}

/** Per-requirement probe list with install hints (copyable, never auto-installed). */
export function RequirementStatusList({ readiness }: { readiness: SkillReadiness }) {
  const { t } = useTranslation();
  const [copyState, setCopyState] = useState<{ hint: string; ok: boolean } | null>(null);
  const copyTimer = useRef<number | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    // StrictMode double-invokes effects: the first cleanup flips this to
    // false, so re-arm it on every setup or clipboard state updates (and
    // the 1.5s reset timer) would silently no-op.
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    };
  }, []);
  if (readiness.requirements.length === 0) return null;

  const copyHint = async (hint: string) => {
    try {
      await navigator.clipboard.writeText(hint);
      if (!mounted.current) return;
      setCopyState({ hint, ok: true });
    } catch {
      if (!mounted.current) return;
      setCopyState({ hint, ok: false });
    } finally {
      if (!mounted.current) return;
      if (copyTimer.current) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopyState((current) => (current && current.hint === hint ? null : current)), 1500);
    }
  };

  return (
    <div className="mt-3 space-y-1.5 border-t border-faint pt-3 text-xs text-muted">
      <div>
        <span className="font-medium text-text">{t("skills.dependencyStatus")}:</span>
        {readiness.ready ? (
          <span className="ml-2 text-ok-text">{t("skills.dependencyAllReady")}</span>
        ) : (
          <span className="ml-2 text-error-text">{t("skills.dependencyBlocked")}</span>
        )}
      </div>
      <ul className="space-y-1.5">
        {readiness.requirements.map((requirement) => (
          <li key={`${requirement.name}:${requirement.kind}`} className="flex items-start gap-2">
            {requirement.status === "ready" ? (
              <Check size={13} className="mt-0.5 shrink-0 text-ok-text" />
            ) : requirement.status === "missing" ? (
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-error-text" />
            ) : (
              <Wrench size={13} className="mt-0.5 shrink-0 text-muted" />
            )}
            <div className="min-w-0 flex-1">
              <span className="text-text">{requirement.name}</span>
              {requirement.version ? <span className="ml-1">({requirement.version})</span> : null}
              {requirement.optional && requirement.status !== "missing-optional" ? <span className="ml-1">· {t("skills.optional")}</span> : null}
              <span className="ml-1">{t(`skills.dependency.${requirement.status}`)}</span>
              {requirement.reason ? <p className="mt-0.5">{requirement.reason}</p> : null}
              {requirement.hint ? (
                <button
                  type="button"
                  aria-label={copyState?.hint === requirement.hint ? (copyState.ok ? t("skills.copied") : t("skills.copyFailed")) : t("skills.copyHint")}
                  onClick={() => void copyHint(requirement.hint!)}
                  className="mt-1 flex items-center gap-1 rounded-input bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted ring-1 ring-border hover:text-text"
                >
                  {copyState?.hint === requirement.hint ? (copyState.ok ? <Check size={10} className="text-ok-text" /> : <AlertTriangle size={10} className="text-error-text" />) : <Copy size={10} />}
                  <span className="max-w-full truncate">{requirement.hint}</span>
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      {copyState ? <span role="status" className="sr-only">{copyState.ok ? t("skills.copied") : t("skills.copyFailed")}</span> : null}
    </div>
  );
}
