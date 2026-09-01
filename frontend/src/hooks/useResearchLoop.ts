import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AutoResearchSnapshot } from "@pi-science/contracts";
import { queryClient } from "../lib/client/query-client";
import { researchGraphApi, researchGraphKey, subscribeResearchGraphEvents } from "../lib/research";
import type { ResearchLoopDraft, ResearchStarter } from "../components/conversation/ResearchLoopControls";

const terminal = new Set(["completed", "failed", "cancelled"]);

/** Conversation entry point for one durable Auto Research Graph. */
export function useResearchLoop(cwd: string, originSessionId?: string) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ResearchStarter | null>(null);
  const [prompt, setPrompt] = useState(() => t("conversation.defaultPrompt"));
  const [draft, setDraft] = useState<ResearchLoopDraft | null>(null);
  const [activeLoop, setActiveLoop] = useState<AutoResearchSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (researchId: string) => {
    const snapshot = await researchGraphApi.detail(cwd, researchId);
    setActiveLoop(snapshot);
    return snapshot;
  }, [cwd]);

  useEffect(() => {
    let cancelled = false;
    void researchGraphApi.list(cwd).then(({ research }) => {
      const active = research.find((item) => !terminal.has(item.status));
      if (!cancelled && active) setActiveLoop(active);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [cwd]);

  const activeId = activeLoop?.research_id;
  const done = !activeLoop || terminal.has(activeLoop.status);
  useEffect(() => {
    if (!activeId || done) return;
    const repair = (event?: { research_id: string }) => {
      if (!event || event.research_id === activeId) void refresh(activeId).catch(() => undefined);
    };
    const unsubscribe = subscribeResearchGraphEvents(cwd, repair);
    const fallback = window.setInterval(() => {
      void queryClient.invalidateQueries({ queryKey: researchGraphKey(cwd) });
      repair();
    }, 30_000);
    return () => { unsubscribe(); window.clearInterval(fallback); };
  }, [activeId, cwd, done, refresh]);

  const intent = async (text: string): Promise<{ kind: "draft" } | { kind: "conversation"; message: string } | null> => {
    if (!mode) return null;
    const objective = text.trim();
    if (!objective) return null;
    setDraft({
      taskType: mode,
      title: objective.replace(/\s+/g, " ").slice(0, 80),
      objective,
      constraints: mode === "reproduce" ? ["Preserve reproducibility and record exact execution evidence."] : [],
      maxExperiments: mode === "evaluate" || mode === "compare" ? 12 : 20,
      maxWallSeconds: 7_200,
      maxParallel: 2,
    });
    return { kind: "draft" };
  };

  const confirm = async () => {
    if (!draft || busy) return;
    setBusy(true); setError(null);
    try {
      const created = await researchGraphApi.create(cwd, {
        title: draft.title.trim(), objective: draft.objective.trim(), origin_session_id: originSessionId ?? null,
        constraints: draft.constraints,
        budget: { max_experiments: draft.maxExperiments, max_wall_seconds: draft.maxWallSeconds, max_parallel: draft.maxParallel },
      });
      const started = await researchGraphApi.action(cwd, created.research_id, "start");
      setActiveLoop(started);
      setDraft(null); setMode(null); setPrompt(t("conversation.defaultPrompt"));
      void queryClient.invalidateQueries({ queryKey: researchGraphKey(cwd) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : t("research.startError")); }
    finally { setBusy(false); }
  };

  const action = async (next: "pause" | "resume" | "cancel") => {
    if (!activeLoop || busy) return;
    setBusy(true); setError(null);
    try { setActiveLoop(await researchGraphApi.action(cwd, activeLoop.research_id, next)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("research.actionError")); }
    finally { setBusy(false); }
  };

  const resolveInput = async (nodeId: string, resolution: string) => {
    if (!activeLoop || busy || !resolution.trim()) return;
    setBusy(true); setError(null);
    try { setActiveLoop(await researchGraphApi.resolveInput(cwd, activeLoop.research_id, nodeId, resolution.trim())); }
    catch (cause) { setError(cause instanceof Error ? cause.message : t("research.actionError")); }
    finally { setBusy(false); }
  };

  return { mode, setMode, prompt, setPrompt, draft, setDraft, activeLoop, busy, error, setError, refresh, intent, confirm, action, resolveInput };
}
