import { useEffect, useState } from "react";
import { BarChart3, Check, Loader2, Pause, Play, Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { projectMemoryApi, useResearchLoops, type ExperienceRecord, type ResearchLoop } from "../../lib/project-memory";
import { EmptyState } from "./EmptyState";
import { LoopActionButton } from "./LoopActionButton";

export function ResearchTab({
  cwd,
  onChanged,
  onError,
}: {
  cwd: string;
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [objective, setObjective] = useState("");
  const [metric, setMetric] = useState("score");
  const [direction, setDirection] = useState<"maximize" | "minimize">("maximize");
  const [frontiers, setFrontiers] = useState<Record<string, ExperienceRecord[]>>({});

  // Every loop mutation invalidates the project-memory resource, so this list reloads
  // itself where the page used to re-run an explicit loader.
  const loopsRead = useResearchLoops(cwd);
  const loops: ResearchLoop[] = loopsRead.data?.loops ?? [];
  const loadError = loopsRead.error;
  useEffect(() => {
    if (loadError) onError(loadError instanceof Error ? loadError.message : t("research.loadError"));
  }, [loadError, onError, t]);

  const create = async () => {
    if (!title.trim() || !objective.trim() || !metric.trim()) return;
    setBusy("create");
    onError(null);
    try {
      const evaluatorId = `eval-${Date.now().toString(36)}`;
      const evaluatorContent = JSON.stringify({ evaluatorId, metric, direction });
      const digestBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(evaluatorContent));
      const digest = `sha256:${[...new Uint8Array(digestBytes)].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
      await projectMemoryApi.registerEvaluator(cwd, {
        evaluator_id: evaluatorId,
        version: 1,
        digest,
        status: "approved",
        metrics: [{ name: metric.trim(), direction, weight: 1 }],
        hard_checks: ["artifact_verified"],
      });
      await projectMemoryApi.createLoop(cwd, {
        title: title.trim(),
        objective: objective.trim(),
        evaluator_ref: { evaluator_id: evaluatorId, version: 1, digest },
      });
      setTitle("");
      setObjective("");
      setCreating(false);
      await onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : t("knowledge.researchCreateError"));
    } finally {
      setBusy(null);
    }
  };

  const action = async (loop: ResearchLoop, next: "prepare" | "start" | "pause" | "resume" | "cancel" | "complete") => {
    setBusy(loop.loop_id);
    onError(null);
    try {
      if (next === "prepare") {
        const result = await projectMemoryApi.preflight(cwd, loop.loop_id);
        if (!result.ok) throw new Error(result.blockers.join("; "));
      } else {
        await projectMemoryApi.action(cwd, loop.loop_id, next);
      }
      await onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : t("knowledge.researchActionError"));
    } finally {
      setBusy(null);
    }
  };

  const toggleFrontier = async (loopId: string) => {
    if (frontiers[loopId]) {
      setFrontiers((current) => {
        const next = { ...current };
        delete next[loopId];
        return next;
      });
      return;
    }
    setBusy(loopId);
    try {
      const result = await projectMemoryApi.frontier(cwd, loopId);
      setFrontiers((current) => ({ ...current, [loopId]: result.frontier }));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : t("knowledge.researchActionError"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 rounded-card border border-border bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-serif text-lg text-text">{t("knowledge.researchTitle")}</h2>
          <p className="mt-1 text-sm text-muted">{t("knowledge.researchDescription")}</p>
        </div>
        <button type="button" onClick={() => setCreating((value) => !value)} className="flex min-h-11 items-center justify-center gap-2 rounded-input bg-accent px-4 py-2 text-sm font-medium text-accent-fg">
          <Plus size={15} /> {t("knowledge.researchNew")}
        </button>
      </div>

      {creating && (
        <section className="rounded-card border border-border bg-surface p-5 shadow-card">
          <div className="grid gap-4 lg:grid-cols-2">
            <label className="text-xs font-medium text-muted">
              {t("knowledge.researchLoopTitle")}
              <input value={title} onChange={(event) => setTitle(event.target.value)} className="mt-1 min-h-11 w-full rounded-input border border-border bg-bg px-3 text-sm text-text" />
            </label>
            <label className="text-xs font-medium text-muted">
              {t("knowledge.researchMetric")}
              <div className="mt-1 flex gap-2">
                <input value={metric} onChange={(event) => setMetric(event.target.value)} className="min-h-11 min-w-0 flex-1 rounded-input border border-border bg-bg px-3 text-sm text-text" />
                <select value={direction} onChange={(event) => setDirection(event.target.value as "maximize" | "minimize")} className="min-h-11 rounded-input border border-border bg-bg px-3 text-sm text-text">
                  <option value="maximize">{t("knowledge.maximize")}</option>
                  <option value="minimize">{t("knowledge.minimize")}</option>
                </select>
              </div>
            </label>
          </div>
          <label className="mt-4 block text-xs font-medium text-muted">
            {t("knowledge.researchObjective")}
            <textarea value={objective} onChange={(event) => setObjective(event.target.value)} rows={4} className="mt-1 w-full rounded-input border border-border bg-bg px-3 py-2 text-sm leading-6 text-text" />
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setCreating(false)} className="min-h-11 rounded-input border border-border px-4 text-sm text-muted">{t("common.cancel")}</button>
            <button type="button" disabled={busy !== null || !title.trim() || !objective.trim()} onClick={() => void create()} className="flex min-h-11 items-center gap-2 rounded-input bg-accent px-4 text-sm font-medium text-accent-fg disabled:opacity-50">
              {busy === "create" && <Loader2 size={14} className="animate-spin" />} {t("knowledge.researchCreate")}
            </button>
          </div>
        </section>
      )}

      {loops.length === 0 ? (
        <EmptyState icon={<Play size={28} />} title={t("knowledge.researchEmpty")} text={t("knowledge.researchEmptyText")} />
      ) : (
        <div className="space-y-3">
          {loops.map((loop) => (
            <article key={loop.loop_id} className="rounded-card border border-border bg-surface p-5 shadow-card">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold text-text">{loop.title}</h3>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10px] text-muted">{loop.status}</span>
                  </div>
                  <p className="mt-2 text-sm leading-6 text-muted">{loop.objective}</p>
                  <div className="mt-2 font-mono text-[10px] text-muted">{loop.loop_id} · {loop.evaluator_ref?.evaluator_id ?? t("knowledge.noEvaluator")}</div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <LoopActionButton busy={busy === loop.loop_id} onClick={() => void toggleFrontier(loop.loop_id)} icon={<BarChart3 size={14} />} label={frontiers[loop.loop_id] ? t("knowledge.researchHideFrontier") : t("knowledge.researchViewFrontier")} />
                  {loop.status === "draft" && <LoopActionButton busy={busy === loop.loop_id} onClick={() => void action(loop, "prepare")} icon={<Check size={14} />} label={t("knowledge.researchPrepare")} />}
                  {loop.status === "ready" && <LoopActionButton busy={busy === loop.loop_id} onClick={() => void action(loop, "start")} icon={<Play size={14} />} label={t("knowledge.researchStart")} />}
                  {loop.status === "running" && <LoopActionButton busy={busy === loop.loop_id} onClick={() => void action(loop, "pause")} icon={<Pause size={14} />} label={t("knowledge.researchPause")} />}
                  {loop.status === "paused" && <LoopActionButton busy={busy === loop.loop_id} onClick={() => void action(loop, "resume")} icon={<Play size={14} />} label={t("knowledge.researchResume")} />}
                  {loop.status === "running" && <LoopActionButton busy={busy === loop.loop_id} onClick={() => void action(loop, "complete")} icon={<Check size={14} />} label={t("knowledge.researchComplete")} />}
                  {!["completed", "failed", "cancelled"].includes(loop.status) && <LoopActionButton busy={busy === loop.loop_id} onClick={() => void action(loop, "cancel")} icon={<X size={14} />} label={t("knowledge.researchCancel")} />}
                </div>
              </div>
              {frontiers[loop.loop_id] && (
                <div className="mt-4 border-t border-border pt-4">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted">{t("knowledge.researchFrontier")}</h4>
                  {frontiers[loop.loop_id].length === 0 ? (
                    <p className="mt-2 text-sm text-muted">{t("knowledge.researchFrontierEmpty")}</p>
                  ) : (
                    <div className="mt-2 grid gap-2 md:grid-cols-2">
                      {frontiers[loop.loop_id].map((experience) => (
                        <div key={experience.candidate_id} className="rounded-input bg-surface-2 p-3">
                          <div className="font-mono text-[10px] text-muted">{experience.candidate_id}</div>
                          <p className="mt-1 text-sm text-text">{experience.proposal.approach_summary}</p>
                          <pre className="mt-2 overflow-auto text-[10px] text-muted">{JSON.stringify(experience.evaluation?.metrics ?? {}, null, 2)}</pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
