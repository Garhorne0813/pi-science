import { ProjectArchives } from "../../components/runs/ProjectArchives";
import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, AlignLeft, Braces, FileSearch, Loader2, Play, AlertTriangle } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { ExecutionRecord } from "@pi-science/contracts";
import { cn, useUiStore } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { getSessionName } from "../../lib/client/session-names";
import { fileInspectorForPath } from "../../lib/artifacts";
import { WorkspacePage, WorkspacePageHeader, WorkspacePageRefreshButton } from "../../components/layout/WorkspacePage";
import { useTranslation } from "react-i18next";
import { reproduceRunPrompt, runLogQuery, runQuery, runsPageQuery } from "../../lib/runs";
import { subscribeExecutionInvalidation } from "../../lib/runs/execution-events";
import { apiRequest, ApiError } from "../../lib/client/api";
import { useFeedback } from "../../components/feedback/feedback-context";
import { useRequiredWorkspaceCwd } from "../../lib/workspace";
import { ExecutionDetails } from "../../components/runs/ExecutionDetails";
import { ExecutionTimeline } from "../../components/runs/ExecutionTimeline";
import { ExecutionLedger } from "../../components/runs/ExecutionLedger";
import { RunsToolbar, RUN_KINDS, RUN_STATUSES } from "../../components/runs/RunsToolbar";
import type { DetailTab } from "../../components/runs/run-types";
import { fileName, isActiveExecution, workspaceRelativePath } from "../../components/runs/run-formatters";

const EMPTY_RUNS: ExecutionRecord[] = [];
const PAGE_SIZE = 50;

export function RunsPage({ sessionId }: { sessionId?: string } = {}) {
  const { t } = useTranslation();
  const { toast } = useFeedback();
  const navigate = useNavigate();
  const workspaceCwd = useRequiredWorkspaceCwd();
  const openInspector = useUiStore((state) => state.openInspector);
  const setComposerDraft = useRuntimeStore((state) => state.setDraft);
  const sessions = useRuntimeStore((state) => state.sessions);
  const sessionTitles = Object.assign(Object.create(null) as Record<string, string>, Object.fromEntries((sessions ?? []).filter((session) => session.cwd === workspaceCwd && session.name).map((session) => [session.id, session.name!])));
  const [showArchives,setShowArchives]=useState(()=>new URLSearchParams(window.location.search).has("archives"));
  const [searchParams, setSearchParams] = useSearchParams();
  const contextSessionId = sessionId || searchParams.get("session_id") || undefined;
  const activeSessionId = searchParams.get("scope") === "workspace" ? undefined : contextSessionId;
  const scopeLabel = activeSessionId ? t("runs.currentSession") : t("runs.workspaceScope");
  const contextTitle = activeSessionId ? sessionTitles[activeSessionId] || getSessionName(workspaceCwd, activeSessionId) || activeSessionId : "";
  const requestedView = searchParams.get("runs_view") || searchParams.get("view");
  const view = requestedView === "list" || requestedView === "timeline" ? requestedView : activeSessionId ? "timeline" : "list";
  const groupBySession = !activeSessionId && searchParams.get("group") !== "none";
  const rawOffset = Number(searchParams.get("offset") || 0);
  const offset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
  const search = searchParams.get("search") || "";
  const from = searchParams.get("from") || "";
  const to = searchParams.get("to") || "";
  const kind = RUN_KINDS.find((value) => value === searchParams.get("kind"));
  const status = RUN_STATUSES.find((value) => value === searchParams.get("status"));
  const selectedId = searchParams.get("execution");
  const pageSelection = searchParams.get("selection") === "page";
  const resetPageSelection: Record<string, string | null> = pageSelection ? { execution: null, selection: null, detail: "0" } : {};
  const invalidRange = Boolean((from && !Number.isFinite(Date.parse(from))) || (to && !Number.isFinite(Date.parse(to))) || (from && to && Date.parse(from) > Date.parse(to)));
  const [detailTab, setDetailTab] = useState<DetailTab>("summary");
  const compactDetailOpen = Boolean(selectedId && searchParams.get("detail") !== "0");
  const [liveConnected, setLiveConnected] = useState(false);

  const updateRoute = (changes: Record<string, string | null>, replace = false) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      for (const [key, value] of Object.entries(changes)) { if (value === null) next.delete(key); else next.set(key, value); }
      return next;
    }, { replace });
  };
  const changeFilters = (changes: Record<string, string | null>, replace = false) => updateRoute({ ...changes, offset: null, ...resetPageSelection }, replace);
  const clearFilters = () => changeFilters({ search: null, kind: null, status: null, from: null, to: null });
  const changeScope = (scope: string) => {
    updateRoute({ scope, session_id: contextSessionId ?? null, offset: null, detail: "0", ...resetPageSelection });
  };
  const selectExecution = (executionId: string) => {
    updateRoute({ execution: executionId, selection: "page", detail: "1" });
    setDetailTab("summary");
  };

  const pageFilters = {
    session_id: activeSessionId, search: search.trim(), kind, status,
    from: from || undefined, to: to || undefined, offset, limit: PAGE_SIZE,
  };
  const runsResult = useQuery({ ...runsPageQuery(workspaceCwd, pageFilters, liveConnected), enabled: !invalidRange });
  const runs = invalidRange ? EMPTY_RUNS : runsResult.data?.executions ?? EMPTY_RUNS;
  const total = runsResult.data?.total;
  const filteredTotal = runsResult.data?.filtered_total ?? runs.length;
  const loading = runsResult.isFetching;
  const pageSelected = runs.find((run) => run.execution_id === selectedId);
  const targetResult = useQuery({ ...runQuery(workspaceCwd, selectedId ?? ""), enabled: Boolean(selectedId && !pageSelected) });
  // Locate explicit cross-page targets separately; selecting a visible row never changes the list key.
  const targetPageQuery = runsPageQuery(workspaceCwd, { ...pageFilters, target_id: selectedId ?? undefined }, liveConnected);
  const targetPageResult = useQuery({ ...targetPageQuery, queryKey: [...targetPageQuery.queryKey, "target-location"], enabled: Boolean(!invalidRange && selectedId && !pageSelection && runsResult.data && !pageSelected && targetResult.data) });
  const targetPage = !pageSelection && !pageSelected ? targetPageResult.data : undefined;
  const selected = pageSelected || (targetResult.data?.execution_id === selectedId ? targetResult.data : undefined);
  const hasSessionKernel = Boolean(sessionId && activeSessionId === sessionId && runs.some((run) => run.kind === "kernel_cell"));

  useEffect(() => subscribeExecutionInvalidation(workspaceCwd, { onConnectionChange: setLiveConnected }), [workspaceCwd]);
  useEffect(() => {
    // A deep-linked target is authoritative, even when outside the current page.
    if (selectedId || !runs[0]) return;
    setSearchParams((current) => {
      if (current.has("execution")) return current;
      const next = new URLSearchParams(current); next.set("execution", runs[0]!.execution_id); next.set("detail", "0"); next.set("selection", "page"); return next;
    }, { replace: true });
  }, [runs, selectedId, setSearchParams]);
  useEffect(() => {
    if (runsResult.error) toast(runsResult.error instanceof Error ? runsResult.error.message : t("runs.loadError"), "error");
  }, [runsResult.error, t, toast]);

  useEffect(() => {
    if (targetPageResult.error) toast(targetPageResult.error instanceof Error ? targetPageResult.error.message : t("runs.loadError"), "error");
  }, [targetPageResult.error, t, toast]);

  const logQuery = runLogQuery(workspaceCwd, selected?.execution_id ?? "");
  const logResult = useQuery({ ...logQuery,
    queryKey: [...logQuery.queryKey, selected?.status, selected?.ended_at, JSON.stringify(selected?.result)],
    enabled: Boolean(selected && detailTab === "output"),
    refetchInterval: selected && isActiveExecution(selected) && detailTab === "output" ? 5_000 : false,
  });
  const logText = logResult.data ? [logResult.data.stdout, logResult.data.stderr].filter(Boolean).join("\n") : undefined;
  useEffect(() => {
    if (logResult.error) toast(logResult.error instanceof Error ? logResult.error.message : t("runs.logError"), "error");
  }, [logResult.error, t, toast]);

  const changePage = (nextOffset: number) => {
    // Explicit URLs without the page-selection marker retain their authoritative target.
    updateRoute({ offset: String(nextOffset), detail: "0",
      ...resetPageSelection });
    setDetailTab("summary");
  };

  const locateTarget = () => {
    if (targetPage?.target_offset != null) {
      updateRoute({ offset: String(targetPage.target_offset), detail: "0" });
    } else {
      // Keep the target ID and relax restrictions explicitly; never substitute a row.
      updateRoute({ scope: "workspace", offset: null, search: null, kind: null, status: null, from: null, to: null, detail: "0" });
    }
  };

  const copyText = async (text: string, message: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(message, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : t("runs.copyError"), "error");
    }
  };

  const openFile = (path: string) => {
    const relative = workspaceRelativePath(path, workspaceCwd);
    if (!relative) {
      toast(t("runs.fileOutsideWorkspace"), "error");
      return;
    }
    openInspector(fileInspectorForPath(relative, fileName(relative), "workspace", workspaceCwd));
  };

  const openArtifact = async (artifact: ExecutionRecord["artifacts"][number]) => {
    try {
      const manifest = await apiRequest<{ path: string }>(`/api/artifacts/${encodeURIComponent(artifact.artifact_id)}?${new URLSearchParams({ cwd: workspaceCwd, version: String(artifact.version) })}`);
      openFile(manifest.path);
    } catch (error) {
      toast(error instanceof Error ? error.message : t("runs.artifactLoadError"), "error");
    }
  };

  const openSession = (run: ExecutionRecord) => {
    const root = `/workspace/${encodeURIComponent(workspaceCwd)}`;
    navigate(run.correlation.session_id ? `${root}/session/${encodeURIComponent(run.correlation.session_id)}` : root);
  };

  const locateExecution = (run: ExecutionRecord) => {
    const toolCallId = run.correlation.tool_call_id;
    if (!toolCallId) return;
    const next = new URLSearchParams(searchParams);
    for (const key of ["view", "runs_view", "execution", "scope", "session_id", "offset", "from", "to", "search", "kind", "status", "group", "detail", "selection"]) next.delete(key);
    next.delete("execution");
    next.set("focus", `tool-${toolCallId}`);
    setSearchParams(next);
  };

  const reproduce = (run: ExecutionRecord) => {
    setComposerDraft(reproduceRunPrompt(run));
    openSession(run);
  };

  const counts = runsResult.data?.status_counts;
  const failures = counts ? ["failed", "timed_out", "interrupted", "lost", "cancelled"].reduce((sum, key) => sum + (counts[key] || 0), 0) : undefined;
  const duration = runsResult.data?.completed_duration_count === 0 ? undefined : runsResult.data?.completed_duration_ms;
  const detailError = targetResult.error;
  const outsidePage = Boolean(selected && !pageSelected && !loading && targetPage);

  return <WorkspacePage className="runs-page">
    <button type="button" className="text-sm text-accent" onClick={()=>setShowArchives(v=>!v)}>{t("memory.archives")}</button>
    {showArchives&&<ProjectArchives cwd={workspaceCwd} onError={message=>{if(message)toast(message,"error");}}/>}
    <WorkspacePageHeader title={t("runs.title")} description={<span title={activeSessionId}>{scopeLabel}{contextTitle && ` · ${contextTitle}`}</span>} actions={<>
      {hasSessionKernel && <button type="button" onClick={() => openInspector({ variant: "notebook-panel" })} className="flex min-h-9 items-center gap-2 rounded-input border border-border bg-surface px-3 text-sm text-text"><Braces size={15} />{t("notebook.openSessionKernel")}</button>}
      <WorkspacePageRefreshButton label={t("common.refresh")} loading={loading} onClick={() => { void runsResult.refetch(); if (selectedId && !pageSelected) void targetResult.refetch(); if (targetPage) void targetPageResult.refetch(); }} />
    </>} />

    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted" aria-label={t("runs.scopeStatistics")}>
        <span><strong className="mr-1 text-xl font-semibold text-text">{total ?? "—"}</strong>{t("runs.executionsTotal")}</span>
        {counts && <><span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-ok" />{t("runs.succeededCount", { count: counts.succeeded || 0 })}</span><span className={cn("flex items-center gap-1.5", failures && "text-error-text")}><AlertTriangle size={14} />{t("runs.problemCount", { count: failures })}</span></>}
        {duration !== undefined && <span>{t("runs.completedDuration", { seconds: (duration / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 }) })}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={t("runs.scope")} value={activeSessionId ? "session" : "workspace"} onChange={(e) => changeScope(e.target.value)} className="min-h-9 rounded-input border border-border bg-surface px-3 text-sm text-text">
          {contextSessionId && <option value="session">{t("runs.currentSession")}</option>}<option value="workspace">{t("runs.workspaceScope")}</option>
        </select>
        <div aria-label={t("runs.view")} role="group" className="flex rounded-input border border-border bg-surface p-0.5">
          {(["list", "timeline"] as const).map((mode) => <button key={mode} type="button" aria-pressed={view === mode} onClick={() => updateRoute({ [sessionId ? "runs_view" : "view"]: mode })} className={cn("flex min-h-8 items-center gap-1.5 rounded px-3 text-sm", view === mode ? "bg-surface-selected font-medium text-text" : "text-muted hover:text-text")}>{mode === "list" ? <AlignLeft size={15} /> : <Activity size={15} />}{t(`runs.${mode}`)}</button>)}
        </div>
      </div>
    </div>
    <RunsToolbar search={search} kind={kind || ""} status={status || ""} from={from} to={to} onChange={changeFilters} onClear={clearFilters} />
    {invalidRange && <p role="alert" className="mt-2 text-sm text-error-text">{t("runs.invalidRange")}</p>}
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
      <span>{t("runs.matchingPage", { filtered: filteredTotal, visible: runs.length })}</span>
      {!activeSessionId && <label className="flex items-center gap-2"><input type="checkbox" checked={groupBySession} onChange={(e) => updateRoute({ group: e.target.checked ? null : "none" })} />{t("runs.groupSession")}</label>}
      <span className="flex items-center gap-1.5" title={t("runs.liveHint")}><span className={cn("h-1.5 w-1.5 rounded-full", liveConnected ? "bg-ok" : "bg-muted")} />{t("runs.live")}</span>
    </div>

    <div className="runs-workbench-container mt-3">
      <div data-testid="runs-workbench" data-compact-detail={compactDetailOpen ? "true" : "false"} className="runs-ledger-layout runs-workbench grid min-h-[560px] overflow-hidden rounded-card border border-border bg-surface">
        {runs.length ? (view === "timeline"
          ? <ExecutionTimeline runs={runs} selectedId={selected?.execution_id ?? null} onSelect={selectExecution} groupBySession={groupBySession} sessionTitles={sessionTitles} />
          : <ExecutionLedger runs={runs} selectedId={selected?.execution_id ?? null} onSelect={selectExecution} groupBySession={groupBySession} sessionTitles={sessionTitles} showSession={!activeSessionId} />)
          : <section className="runs-ledger-pane min-w-0">{loading ? <div className="p-10 text-center text-muted"><Loader2 className="mx-auto animate-spin" size={20} />{t("common.loading")}</div> : runsResult.error ? <EmptyState icon={<AlertTriangle size={32} />} title={t("runs.loadError")} hint={String(runsResult.error)} /> : <EmptyState icon={search || kind || status || from || to ? <FileSearch size={36} /> : <Play size={36} />} title={t(search || kind || status || from || to ? "runs.noMatches" : "runs.empty")} hint={t(search || kind || status || from || to ? "runs.noMatchesHint" : "runs.emptyHint")} />}</section>}
        <section aria-label={t("runs.details")} className="runs-detail-pane min-w-0 bg-bg/40">
          {outsidePage && <div role="status" className="shrink-0 border-b border-border bg-surface-2 px-4 py-3 text-sm text-text"><p>{t(targetPage?.target_matches === false ? "runs.targetOutsideFilters" : "runs.targetOutsidePage")}</p><button type="button" onClick={locateTarget} className="mt-2 rounded-input border border-border bg-surface px-3 py-1.5 text-xs font-medium">{t(targetPage?.target_offset != null ? "runs.locateTargetPage" : "runs.relaxTargetFilters")}</button></div>}
          {selected ? <ExecutionDetails run={selected} tab={detailTab} onTabChange={setDetailTab} onBack={() => updateRoute({ detail: "0" }, true)} onCopy={(text, message) => void copyText(text, message)} onOpenFile={openFile} onOpenArtifact={(artifact) => void openArtifact(artifact)}
            onOpenSession={selected.correlation.session_id && selected.correlation.session_id !== sessionId ? () => openSession(selected) : undefined}
            onLocate={sessionId && selected.correlation.session_id === sessionId && selected.correlation.tool_call_id ? () => locateExecution(selected) : undefined}
            onReproduce={() => reproduce(selected)} sessionTitle={selected.correlation.session_id ? sessionTitles[selected.correlation.session_id] : undefined}
            log={logResult.data ? { text: logText || t("runs.noLog"), complete: logResult.data.complete } : logResult.error ? { text: t("runs.logLoadFailed"), complete: false } : undefined} loadingLog={logResult.isFetching} />
            : detailError ? <div role="alert" className="p-6"><button type="button" onClick={() => updateRoute({ detail: "0" }, true)} className="runs-detail-back mb-4 text-sm text-muted">{t("runs.backToLedger")}</button><p className="text-sm text-error-text">{t(detailError instanceof ApiError && detailError.status === 404 ? "runs.targetMissing" : "runs.targetLoadError", { id: selectedId })}</p></div>
            : <EmptyState icon={<Activity size={32} />} title={t(selectedId ? "common.loading" : "runs.selectExecution")} hint={selectedId || ""} />}
        </section>
      </div>
    </div>
    <nav aria-label={t("runs.pagination")} className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm text-text">
      <button type="button" disabled={offset === 0 || loading} onClick={() => { changePage(Math.max(0, offset - PAGE_SIZE)); }} className="rounded-input border border-border px-3 py-2 disabled:opacity-40">{t("runs.previous")}</button>
      <span>{scopeLabel} · {t("runs.pagePosition", { from: runs.length ? offset + 1 : 0, to: runs.length ? offset + runs.length : 0, total: filteredTotal })}</span>
      <button type="button" disabled={offset + runs.length >= filteredTotal || loading || invalidRange} onClick={() => { changePage(offset + PAGE_SIZE); }} className="rounded-input border border-border px-3 py-2 disabled:opacity-40">{t("runs.next")}</button>
    </nav>
  </WorkspacePage>;
}

function EmptyState({ icon, title, hint }: { icon: ReactNode; title: string; hint: string }) {
  return <div className="px-4 py-16 text-center"><div className="mx-auto mb-3 w-fit text-muted/50">{icon}</div><p className="text-sm text-text">{title}</p><p className="mt-2 break-all text-xs text-muted">{hint}</p></div>;
}
