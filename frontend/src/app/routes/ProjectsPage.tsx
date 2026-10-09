import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FolderOpen, Plus, Loader2, MessageSquare, FolderInput, Pin, PinOff, Pencil, Trash2, Activity, Search, Grid2X2, LayoutList, ArrowRight, Clock3, Sparkles, X } from "lucide-react";
import { cn } from "../../lib/ui";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { useTranslation } from "react-i18next";
import { useFeedback } from "../../components/feedback/feedback-context";
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../../lib/client/api";
import { queryClient } from "../../lib/client/query-client";
import { timeAgo } from "../../lib/shared";
import { workspacePathLeaf } from "../../lib/workspace";
import { randomIdSuffix } from "../../lib/research";

interface Workspace {
  name: string;
  path: string;
  project_id: string;
  session_count: number;
  last_modified: string;
  last_activity_at?: string;
}

const workspacesKey = ["workspaces"];
const workspacesQuery = {
  queryKey: workspacesKey,
  queryFn: ({ signal }: { signal: AbortSignal }) => apiRequest<Workspace[]>("/api/workspaces", {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  }),
};
const pinnedQuery = { queryKey: ["workspaces", "pinned"], queryFn: () => apiRequest<{ paths?: string[] }>("/api/workspaces/pinned") };

/** Every workspace write drops the whole list — the old invalidateApiCache("/api/workspaces").
 *  The prefix covers the pinned list too, exactly as the URL-prefix cache did. */
function invalidateWorkspaces() {
  void queryClient.invalidateQueries({ queryKey: workspacesKey });
}

/** Optimistic pin update so the star flips before the list refetches. */
function setPinnedPaths(paths: string[]) {
  queryClient.setQueryData(pinnedQuery.queryKey, { paths });
}

export type ProjectSort = "recent" | "name" | "sessions";

function activityAt(w: Workspace) {
  return Date.parse(w.last_activity_at ?? w.last_modified) || 0;
}

export function sortProjects<T extends Workspace>(items: T[], mode: ProjectSort): T[] {
  return [...items].sort((a, b) => {
    if (mode === "name") return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.path.localeCompare(b.path);
    if (mode === "sessions") return b.session_count - a.session_count || activityAt(b) - activityAt(a) || a.path.localeCompare(b.path);
    return activityAt(b) - activityAt(a) || a.name.localeCompare(b.name);
  });
}

export function ProjectsPage() {
  const { t } = useTranslation();
  const { toast, confirm: confirmAction } = useFeedback();
  const [creating, setCreating] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [importingFolder, setImportingFolder] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<ProjectSort>("recent");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const dirInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const workspacesResult = useQuery(workspacesQuery);
  // Pinned paths stored server-side in ~/.pi-science/pinned.json — shared across browsers
  const pinnedResult = useQuery(pinnedQuery);
  const workspaces = useMemo(() => workspacesResult.data ?? [], [workspacesResult.data]);
  const pinned = useMemo(() => new Set(pinnedResult.data?.paths ?? []), [pinnedResult.data]);
  const loadWorkspaces = useCallback(async () => { await workspacesResult.refetch(); }, [workspacesResult]);

  const workspacesFailed = workspacesResult.isError;
  useEffect(() => { if (workspacesFailed) toast(t("projects.loadError"), "error"); }, [workspacesFailed, t, toast]);

  const loading = workspacesResult.isPending;

  const handleCreate = async () => {
    setCreating(true);
    try {
      const name = `Untitled Workspace ${randomIdSuffix(8)}`;
      await apiRequest("/api/workspaces", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      invalidateWorkspaces();
      const updated = await queryClient.fetchQuery(workspacesQuery);
      const newest = updated.find((w: Workspace) => w.name === name);
      if (newest) {
        setSearch("");
        setEditingName(newest.path);
        setEditValue("");
        setTimeout(() => nameInputRef.current?.focus(), 50);
      }
    } catch {
      toast(t("projects.createError"), "error");
    }
    finally { setCreating(false); }
  };

  const handleRename = async (oldPath: string) => {
    const newName = editValue.trim();
    // Clear editing state immediately so onBlur doesn't fire a second rename
    // when the alert dialog steals focus.
    setEditingName(null);
    setEditValue("");
    if (!newName || newName === workspacePathLeaf(oldPath)) {
      return;
    }
    try {
      await apiRequest("/api/workspaces/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: oldPath, name: newName }),
      });
      invalidateWorkspaces();
      toast(t("projects.renamed"), "success");
    } catch { toast(t("projects.renameError"), "error"); }
    await loadWorkspaces();
  };

  const handleDelete = async (path: string) => {
    const name = workspacePathLeaf(path);
    if (!await confirmAction({
      title: t("projects.deleteTitle"),
      message: t("projects.deleteConfirm", { name }),
      confirmLabel: t("common.delete"),
      destructive: true,
    })) return;
    try {
      await apiRequest("/api/workspaces/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      // Also unpin if pinned (server-side)
      if (pinned.has(path)) {
        await apiRequest("/api/workspaces/unpin", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path }),
        });
        setPinnedPaths([...pinned].filter((item) => item !== path));
      }
      invalidateWorkspaces();
      await loadWorkspaces();
      toast(t("projects.deleted", { name }), "success");
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        invalidateWorkspaces();
        await loadWorkspaces();
        return;
      }
      toast(t("projects.deleteError"), "error");
    }
  };

  const togglePin = async (path: string) => {
    const isPinned = pinned.has(path);
    const endpoint = isPinned ? "/api/workspaces/unpin" : "/api/workspaces/pin";
    try {
      await apiRequest(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
      });
      const next = new Set(pinned);
      if (isPinned) next.delete(path); else next.add(path);
      setPinnedPaths([...next]);
      invalidateWorkspaces();
    } catch { toast(t("projects.pinError"), "error"); }
  };

  const handleOpenFolder = () => {
    const input = dirInputRef.current;
    if (input) {
      input.value = "";
      input.click();
    }
  };

  const handleFolderPicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const relPath = (files[0] as any).webkitRelativePath || files[0].name;
    const folderName = relPath.split("/")[0];
    const entries = Array.from(files).map((file) => {
      const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      return {
        file,
        relativePath: relativePath.startsWith(`${folderName}/`) ? relativePath.slice(folderName.length + 1) : file.name,
      };
    });
    setImportingFolder(true);
    try {
      let workspaceName = folderName || `Imported Workspace ${randomIdSuffix(6)}`;
      let suffix = 2;
      let w: Workspace | null = null;
      while (!w) {
        try {
          w = await apiRequest<Workspace>("/api/workspaces", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: workspaceName }),
          });
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 409) throw error;
          workspaceName = `${folderName} (${suffix})`;
          suffix += 1;
        }
      }
      for (const entry of entries) {
        const form = new FormData();
        form.append("file", entry.file, entry.file.name);
        await apiRequest(`/api/files/upload?${new URLSearchParams({ cwd: w.path, path: entry.relativePath })}`, {
          method: "POST",
          body: form,
        });
      }
      invalidateWorkspaces();
      await loadWorkspaces();
      navigate(`/workspace/${encodeURIComponent(w.path)}`);
    } catch { toast(t("projects.openError"), "error"); }
    finally { setImportingFolder(false); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 size={24} className="animate-spin text-muted" /></div>;


  const lastWorkspace = sortProjects(workspaces, "recent")[0];
  const sessionsTotal = workspaces.reduce((sum, w) => sum + w.session_count, 0);
  const pinnedTotal = workspaces.filter(w => pinned.has(w.path)).length;
  const needle = search.trim().toLocaleLowerCase();
  const visible = sortProjects(workspaces.filter(w => !needle || (w.name + " " + w.path).toLocaleLowerCase().includes(needle)), sort);
  const pinnedWs = visible.filter(w => pinned.has(w.path));
  const unpinnedWs = visible.filter(w => !pinned.has(w.path));
  const cards = (items: Workspace[]) => (
    <div className={cn(viewMode === "grid" ? "grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" : "flex flex-col gap-2")}>
      {items.map(w => <WorkspaceCard key={w.path} w={w} {...{ pinned, togglePin, editingName, setEditingName, editValue, setEditValue, handleRename, handleDelete, nameInputRef, navigate, timeAgo, viewMode }} />)}
    </div>
  );

  return (
    <ErrorBoundary>
      <div className="h-full overflow-y-auto bg-bg">
        <div className="mx-auto w-full max-w-[1360px] px-card pb-16 pt-8 sm:px-page lg:px-10 lg:pt-12">
          <input
            ref={dirInputRef}
            type="file"
            // @ts-ignore webkitdirectory is widely supported
            {...{ webkitdirectory: "", directory: "" }}
            className="hidden"
            onChange={handleFolderPicked}
            aria-label={t("projects.openFolder")}
          />

          <header className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
            <div>
              <div className="mb-2 flex items-center gap-2 text-ui-caption font-semibold uppercase tracking-[0.16em] text-accent">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                {t("projects.workbench")}
              </div>
              <h1 className="text-3xl font-semibold tracking-[-0.035em] text-text sm:text-4xl">{t("nav.projects")}</h1>
              <p className="mt-2 max-w-xl text-sm leading-6 text-muted">{t("projects.description")}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={handleOpenFolder} disabled={creating || importingFolder}
                className="inline-flex h-primary items-center gap-2 rounded-input border border-border bg-surface-raised px-4 text-ui-body font-medium text-text transition-colors hover:bg-surface-2 disabled:opacity-50">
                {importingFolder ? <Loader2 size={16} className="animate-spin" /> : <FolderInput size={16} />}
                {t("projects.openFolder")}
              </button>
              <button type="button" onClick={handleCreate} disabled={creating || importingFolder}
                className="inline-flex h-primary items-center gap-2 rounded-input bg-accent-fill px-4 text-ui-body font-semibold text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50">
                {creating ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
                {t("projects.newWorkspace")}
              </button>
            </div>
          </header>

          {workspacesFailed ? (
            <div role="alert" className="rounded-2xl border border-border bg-surface-raised px-6 py-16 text-center">
              <p className="text-ui-body text-muted">{t("projects.loadError")}</p>
              <button type="button" onClick={() => void loadWorkspaces()} disabled={workspacesResult.isFetching}
                className="mt-4 rounded-input bg-accent-fill px-4 py-2 text-ui-body text-accent-fg disabled:opacity-50">{t("common.refresh")}</button>
            </div>
          ) : (
          <>
          <div className="mb-9 grid gap-3 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
            <section className="relative flex min-h-[215px] flex-col justify-between overflow-hidden rounded-2xl border border-border bg-surface-2 p-6 sm:p-7">
              <div className="pointer-events-none absolute -right-14 -top-24 h-64 w-64 rounded-full border-[35px] border-accent/5" />
              <div className="pointer-events-none absolute -bottom-28 right-20 h-52 w-52 rounded-full border-[26px] border-accent/5" />
              <div className="relative">
                <span className="mb-3 inline-flex items-center gap-2 rounded-full border border-accent/15 bg-accent/5 px-3 py-1 text-ui-caption font-medium text-accent">
                  <Sparkles size={13} /> {t("projects.overview")}
                </span>
                <h2 className="max-w-lg text-xl font-semibold leading-snug tracking-tight text-text sm:text-2xl">{t("projects.overviewTitle")}</h2>
                <p className="mt-2 max-w-lg text-ui-body leading-6 text-muted">{t("projects.overviewDescription")}</p>
              </div>
              <div className="relative mt-6 flex flex-wrap items-end gap-x-9 gap-y-4">
                <div><p className="text-2xl font-semibold tracking-tight tabular-nums text-text">{workspaces.length}</p><p className="mt-1 text-ui-caption text-muted">{t("projects.totalProjects")}</p></div>
                <div><p className="text-2xl font-semibold tracking-tight tabular-nums text-text">{sessionsTotal}</p><p className="mt-1 text-ui-caption text-muted">{t("projects.totalSessions")}</p></div>
                <div><p className="text-2xl font-semibold tracking-tight tabular-nums text-text">{pinnedTotal}</p><p className="mt-1 text-ui-caption text-muted">{t("projects.pinnedProjects")}</p></div>
              </div>
            </section>
            <section className="flex min-h-[215px] flex-col justify-between rounded-2xl border border-border bg-surface-raised p-6 sm:p-7">
              <div className="flex items-center gap-2 text-ui-caption font-medium text-muted"><Clock3 size={15} />{t("projects.lastEdited")}</div>
              {lastWorkspace ? (
                <div className="mt-5 min-w-0">
                  <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-accent-soft text-accent"><FolderOpen size={20} /></div>
                  <h3 className="truncate text-lg font-semibold tracking-tight text-text" title={lastWorkspace.name}>{lastWorkspace.name}</h3>
                  <p className="mt-1 text-ui-caption text-muted">{t("projects.editedAgo", { time: timeAgo(lastWorkspace.last_activity_at ?? lastWorkspace.last_modified) })}</p>
                  <Link to={"/workspace/" + encodeURIComponent(lastWorkspace.path)}
                    className="mt-4 inline-flex items-center gap-1.5 text-ui-body font-semibold text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
                    {t("projects.continueProject")} <ArrowRight size={15} />
                  </Link>
                </div>
              ) : (
                <div className="mt-5"><h3 className="text-lg font-semibold text-text">{t("projects.startHere")}</h3><p className="mt-2 text-ui-body leading-6 text-muted">{t("projects.startHereDescription")}</p></div>
              )}
            </section>
          </div>

          <section aria-labelledby="projects-library-title">
            <div className="mb-4 flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
              <div>
                <h2 id="projects-library-title" className="text-lg font-semibold tracking-tight text-text">{t("projects.library")}</h2>
                <p className="mt-1 text-ui-body text-muted">{t("projects.workspaceCount", { count: workspaces.length })}</p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative min-w-0 sm:w-64">
                  <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                  <input type="search" value={search} onChange={e => setSearch(e.target.value)}
                    placeholder={t("projects.searchPlaceholder")} aria-label={t("projects.searchPlaceholder")}
                    className="h-control w-full rounded-input border border-border bg-surface-raised pl-9 pr-9 text-ui-body text-text outline-none placeholder:text-muted/70 focus:border-accent/50 focus:ring-2 focus:ring-accent/10" />
                  {search && <button type="button" onClick={() => setSearch("")} aria-label={t("projects.clearSearch")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-text"><X size={14} /></button>}
                </div>
                <select value={sort} onChange={e => setSort(e.target.value as ProjectSort)}
                  aria-label={t("projects.sortLabel")}
                  className="h-control rounded-input border border-border bg-surface-raised px-3 text-ui-body text-text outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/10">
                  <option value="recent">{t("projects.sortRecent")}</option>
                  <option value="name">{t("projects.sortName")}</option>
                  <option value="sessions">{t("projects.sortSessions")}</option>
                </select>
                <div role="group" aria-label={t("projects.viewLabel")} className="inline-flex h-control w-fit shrink-0 gap-0.5 rounded-input border border-border bg-surface-raised p-1">
                  <button type="button" onClick={() => setViewMode("grid")} aria-label={t("projects.gridView")} aria-pressed={viewMode === "grid"}
                    className={cn("flex h-full w-8 items-center justify-center rounded-md", viewMode === "grid" ? "bg-accent/10 text-accent" : "text-muted hover:bg-surface-2")}><Grid2X2 size={16} /></button>
                  <button type="button" onClick={() => setViewMode("list")} aria-label={t("projects.listView")} aria-pressed={viewMode === "list"}
                    className={cn("flex h-full w-8 items-center justify-center rounded-md", viewMode === "list" ? "bg-accent/10 text-accent" : "text-muted hover:bg-surface-2")}><LayoutList size={16} /></button>
                </div>
              </div>
            </div>

            {workspaces.length === 0 ? (
              <div className="flex flex-col items-center rounded-2xl border border-dashed border-border bg-surface/40 px-6 py-16 text-center">
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10 text-accent"><FolderOpen size={26} /></div>
                <h3 className="text-lg font-semibold text-text">{t("projects.emptyTitle")}</h3>
                <p className="mt-2 max-w-sm text-ui-body leading-6 text-muted">{t("projects.empty")}</p>
                <button type="button" onClick={handleCreate} disabled={creating || importingFolder} className="mt-5 inline-flex h-primary items-center gap-2 rounded-input bg-accent-fill px-4 text-ui-body font-medium text-accent-fg disabled:opacity-50"><Plus size={16} />{t("projects.newWorkspace")}</button>
              </div>
            ) : visible.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border bg-surface/40 px-6 py-14 text-center">
                <Search size={24} className="mx-auto text-muted" />
                <h3 className="mt-3 text-base font-semibold text-text">{t("projects.noResults")}</h3>
                <p className="mt-1 text-ui-body text-muted">{t("projects.noResultsDescription")}</p>
                <button type="button" onClick={() => setSearch("")} className="mt-4 text-ui-body font-semibold text-accent hover:underline">{t("projects.clearSearch")}</button>
              </div>
            ) : (
              <div className="space-y-8">
                {pinnedWs.length > 0 && (
                  <div>
                    <div className="mb-3 flex items-center gap-2.5"><Pin size={15} className="text-accent" /><h3 className="text-ui-body font-semibold text-text">{t("projects.pinned")}</h3><span className="rounded-full bg-surface-2 px-2 py-0.5 text-ui-meta tabular-nums text-muted">{pinnedWs.length}</span></div>
                    {cards(pinnedWs)}
                  </div>
                )}
                {unpinnedWs.length > 0 && (
                  <div>
                    <div className="mb-3 flex items-center gap-2.5"><FolderOpen size={15} className="text-accent" /><h3 className="text-ui-body font-semibold text-text">{t("projects.allProjects")}</h3><span className="rounded-full bg-surface-2 px-2 py-0.5 text-ui-meta tabular-nums text-muted">{unpinnedWs.length}</span></div>
                    {cards(unpinnedWs)}
                  </div>
                )}
              </div>
            )}
          </section>
          </>
          )}
        </div>
      </div>
    </ErrorBoundary>
  );
}

/* ── Workspace Card ── */

export function WorkspaceCard({ w, pinned, togglePin, editingName, setEditingName, editValue, setEditValue, handleRename, handleDelete, nameInputRef, navigate, timeAgo, viewMode = "grid" }: {
  w: Workspace;
  pinned: Set<string>;
  togglePin: (path: string) => void;
  editingName: string | null;
  setEditingName: (v: string | null) => void;
  editValue: string;
  setEditValue: (v: string) => void;
  handleRename: (path: string) => Promise<void>;
  handleDelete: (path: string) => Promise<void>;
  nameInputRef: React.RefObject<HTMLInputElement | null>;
  navigate: (to: string) => void;
  timeAgo: (d: string) => string;
  viewMode?: "grid" | "list";
}) {
  const { t } = useTranslation();
  const isPinned = pinned.has(w.path);
  const isList = viewMode === "list";

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingName(w.path);
    setEditValue(w.name);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  return (
    <article className={cn(
      "group relative min-w-0 overflow-hidden rounded-xl border border-border bg-surface-raised transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-card focus-within:border-accent/40",
      isPinned && "border-accent/20",
      isList ? "flex flex-wrap items-center gap-4 px-4 py-3 sm:px-5" : "flex min-h-[208px] flex-col p-5",
    )}>
      <Link
        to={"/workspace/" + encodeURIComponent(w.path)}
        aria-label={t("projects.open", { name: w.name })}
        className="absolute inset-0 z-[1] cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        <span className="sr-only">{t("projects.open", { name: w.name })}</span>
      </Link>
      <div className={cn("flex shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent", isList ? "h-11 w-11" : "h-12 w-12")}>
        <FolderOpen size={isList ? 21 : 23} strokeWidth={1.75} />
      </div>
      <div className={cn("min-w-0", isList ? "min-w-[110px] flex-1" : "mt-4 flex-1")}>
        {editingName === w.path ? (
          <input
            ref={nameInputRef}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
              if (e.key === "Escape") { e.preventDefault(); setEditValue(""); setEditingName(null); }
            }}
            onBlur={() => handleRename(w.path)}
            onClick={(e) => e.stopPropagation()}
            placeholder={w.name}
            aria-label={t("projects.rename")}
            className="relative z-20 w-full rounded-input border border-accent bg-surface px-2 py-1 text-ui-body font-semibold text-text outline-none"
          />
        ) : (
          <h4 className="truncate text-ui-body font-semibold text-text" title={w.name}>{w.name}</h4>
        )}
        <p className="mt-1 truncate text-ui-caption text-muted/80" title={w.path}>{w.path}</p>
        <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-ui-caption text-muted", isList ? "mt-1.5" : "mt-4")}>
          <span className="inline-flex items-center gap-1.5"><MessageSquare size={13} />{t("projects.sessionCount", { count: w.session_count })}</span>
          <span className="inline-flex items-center gap-1.5"><Clock3 size={13} />{timeAgo(w.last_activity_at ?? w.last_modified)}</span>
        </div>
      </div>
      <div className={cn("relative z-10 flex shrink-0 items-center gap-1", isList ? "ml-auto" : "absolute right-3 top-3")}>
        <button type="button" onClick={() => togglePin(w.path)}
          title={isPinned ? t("projects.unpin") : t("projects.pin")}
          aria-label={isPinned ? t("projects.unpin") : t("projects.pin")}
          className={cn("flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-surface-2", isPinned ? "text-accent" : "text-muted hover:text-text")}>
          {isPinned ? <Pin size={15} fill="currentColor" /> : <PinOff size={15} />}
        </button>
        <button type="button" onClick={startEdit} title={t("projects.rename")} aria-label={t("projects.rename")}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-text"><Pencil size={15} /></button>
        <button type="button" onClick={() => handleDelete(w.path)} title={t("projects.deleteTitle")} aria-label={t("projects.deleteTitle")}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-error/10 hover:text-error-text"><Trash2 size={15} /></button>
        <button type="button" onClick={() => navigate("/workspace/" + encodeURIComponent(w.path) + "/runs")} title={t("runs.viewAll")} aria-label={t("runs.viewAll")}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-accent"><Activity size={15} /></button>
      </div>
    </article>
  );
}
