import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { projectMemoryApi, projectMemoryKey, type ResearchLoopDetail } from "../lib/project-memory";
import { queryClient } from "../lib/query-client";
import { subscribeResearchInvalidation } from "../lib/research-events";
import { contentDigest, randomIdSuffix } from "../lib/research-identity";
import type { ResearchLoopDraft, ResearchStarter } from "../components/conversation/ResearchLoopControls";

/** Research-loop intent → draft → confirm → run lifecycle for one workspace. */
export function useResearchLoop(cwd: string) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ResearchStarter | null>(null);
  const [prompt, setPrompt] = useState(() => t("conversation.defaultPrompt"));
  const [draft, setDraft] = useState<ResearchLoopDraft | null>(null);
  const [activeLoop, setActiveLoop] = useState<ResearchLoopDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (loopId: string) => {
    setActiveLoop(await projectMemoryApi.loop(cwd, loopId));
  }, [cwd]);

  useEffect(() => {
    void projectMemoryApi.loops(cwd).then((result) => {
      const active = result.loops.find((loop) => !["completed", "failed", "cancelled"].includes(loop.status));
      if (active) void refresh(active.loop_id);
    }).catch(() => undefined);
  }, [cwd, refresh]);

  const activeLoopId = activeLoop?.loop_id;
  const activeLoopDone = !activeLoop || ["completed", "failed", "cancelled"].includes(activeLoop.status);
  useEffect(() => {
    if (!activeLoopId || activeLoopDone) return;
    // SSE invalidation signal with a slow fallback poll; keyed on loop_id (not the
    // detail object) so refetches don't churn the EventSource via identity changes.
    const refreshLoop = () => { void refresh(activeLoopId).catch(() => undefined); };
    const unsubscribe = subscribeResearchInvalidation(cwd, refreshLoop);
    const timer = window.setInterval(() => { void queryClient.invalidateQueries({ queryKey: projectMemoryKey() }); refreshLoop(); }, 30_000);
    return () => { unsubscribe(); window.clearInterval(timer); };
  }, [activeLoopId, activeLoopDone, cwd, refresh]);

  /** Turn a free-text prompt into a loop draft. Resolves true when a draft was produced. */
  const intent = async (text: string): Promise<boolean> => {
    setBusy(true); setError(null);
    try {
      const result = await projectMemoryApi.intent(cwd, text);
      setDraft({ title: result.draft.title, objective: result.draft.objective, metric: "score", direction: "maximize", maxCandidates: result.draft.budget.max_candidates, maxWallSeconds: result.draft.budget.max_wall_seconds });
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("research.prepareError")); return false; }
    finally { setBusy(false); }
  };

  const confirm = async () => {
    if (!draft || busy) return;
    setBusy(true); setError(null);
    try {
      const evaluatorId = `eval-${randomIdSuffix()}`;
      const evaluatorContent = JSON.stringify({ evaluatorId, metric: draft.metric, direction: draft.direction, source: "deterministic" });
      const digest = await contentDigest(evaluatorContent);
      await projectMemoryApi.registerEvaluator(cwd, { evaluator_id: evaluatorId, version: 1, digest, status: "approved", metrics: [{ name: draft.metric.trim(), direction: draft.direction, weight: 1, source: "deterministic" }], hard_checks: ["artifact_verified"] });
      const targetMetrics = draft.target == null ? {} : { [draft.metric.trim()]: draft.target };
      const loop = await projectMemoryApi.createLoop(cwd, { title: draft.title.trim(), objective: draft.objective.trim(), evaluator_ref: { evaluator_id: evaluatorId, version: 1, digest }, budget: { max_candidates: draft.maxCandidates, max_wall_seconds: draft.maxWallSeconds, max_parallel: 1 }, stop_conditions: { target_metrics: targetMetrics, patience: 5, min_improvement: 0 } });
      const preflight = await projectMemoryApi.preflight(cwd, loop.loop_id);
      if (!preflight.ok) throw new Error(preflight.blockers.join("; "));
      await projectMemoryApi.action(cwd, loop.loop_id, "start");
      await refresh(loop.loop_id);
      setDraft(null); setMode(null); setPrompt(t("conversation.defaultPrompt"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("research.startError")); }
    finally { setBusy(false); }
  };

  const action = async (next: "pause" | "resume" | "cancel") => {
    if (!activeLoop || busy) return;
    setBusy(true); setError(null);
    try { await projectMemoryApi.action(cwd, activeLoop.loop_id, next); await refresh(activeLoop.loop_id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("research.actionError")); }
    finally { setBusy(false); }
  };

  return { mode, setMode, prompt, setPrompt, draft, setDraft, activeLoop, busy, error, setError, refresh, intent, confirm, action };
}
