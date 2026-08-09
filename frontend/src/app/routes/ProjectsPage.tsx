import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderOpen, Plus, Loader2, MessageSquare, FolderInput, ChevronDown, Pin, PinOff, Pencil, Trash2, X, Dna, Earth } from "lucide-react";
import { cn } from "../../lib/ui";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { useTranslation } from "react-i18next";
import { useFeedback } from "../../components/feedback/feedback-context";
import { useQuery } from "@tanstack/react-query";
import { ApiError, apiRequest } from "../../lib/client/api";
import { queryClient } from "../../lib/client/query-client";
import { timeAgo } from "../../lib/shared";
import { workspacePathLeaf } from "../../lib/workspace";

interface Workspace {
  name: string;
  path: string;
  project_id: string;
  session_count: number;
  last_modified: string;
}

// ── Demo dismissal (localStorage — UI preference, not data) ──

function loadDismissedDemos(): Set<string> {
  try {
    const raw = localStorage.getItem("pi-science-dismissed-demos");
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}

function saveDismissedDemos(set: Set<string>) {
  localStorage.setItem("pi-science-dismissed-demos", JSON.stringify([...set]));
}

const workspacesKey = ["workspaces"];
const workspacesQuery = { queryKey: workspacesKey, queryFn: () => apiRequest<Workspace[]>("/api/workspaces") };
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

export function ProjectsPage() {
  const { t } = useTranslation();
  const { toast, confirm: confirmAction } = useFeedback();
  const [creating, setCreating] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [installingDemo, setInstallingDemo] = useState(false);
  const [importingFolder, setImportingFolder] = useState(false);
  const [dismissedDemos, setDismissedDemos] = useState<Set<string>>(loadDismissedDemos);
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

  // Safety: stop showing the spinner after 10s even if the API never responds
  const [loadTimedOut, setLoadTimedOut] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setLoadTimedOut(true), 10000);
    return () => clearTimeout(timer);
  }, []);
  const loading = workspacesResult.isPending && !loadTimedOut;

  const handleCreate = async () => {
    setCreating(true); setDropdownOpen(false);
    try {
      const name = `Untitled Workspace ${crypto.randomUUID().slice(0, 8)}`;
      await apiRequest("/api/workspaces", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      invalidateWorkspaces();
      const updated = await queryClient.fetchQuery(workspacesQuery);
      const newest = updated.find((w: Workspace) => w.name === name);
      if (newest) {
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

  const dismissDemo = (name: string) => {
    const next = new Set(dismissedDemos);
    next.add(name);
    setDismissedDemos(next);
    saveDismissedDemos(next);
  };

  const handleOpenFolder = () => {
    setDropdownOpen(false);
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
      let workspaceName = folderName || `Imported Workspace ${crypto.randomUUID().slice(0, 6)}`;
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

  const installDemo = async (name: string) => {
    setInstallingDemo(true);
    try {
      const w = await apiRequest<Workspace>(`/api/workspaces/demo?name=${name}`, { method: "POST" });
      navigate(`/workspace/${encodeURIComponent(w.path)}`);
    } catch { toast(t("projects.demoError"), "error"); }
    finally { setInstallingDemo(false); }
  };

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 size={24} className="animate-spin text-muted" /></div>;

  // Split into pinned & unpinned
  const pinnedWs = workspaces.filter(w => pinned.has(w.path));
  const unpinnedWs = workspaces.filter(w => !pinned.has(w.path));
  const demos = [
    { name: "molecules", icon: Dna, title: "Molecular Playground", desc: "Lysozyme structure · Aspirin · Caffeine · Drug-likeness analysis" },
    { name: "climate", icon: Earth, title: "Climate Trends", desc: "Global temperature anomaly data (NASA GISTEMP v4) with guided analysis" },
  ];

  return (
    <ErrorBoundary>
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1200px] px-card py-page sm:px-page lg:py-12">
        {/* Header */}
        <div className="mb-page flex items-center justify-between">
          <div>
            <h1 className="font-serif text-xl text-text">{t("nav.projects")}</h1>
            <p className="mt-1 text-sm text-muted">{t("projects.workspaceCount", { count: workspaces.length })}</p>
          </div>
          <div className="relative">
            <input
              ref={dirInputRef}
              type="file"
              // @ts-ignore webkitdirectory is widely supported
              {...{ webkitdirectory: "", directory: "" }}
              className="hidden"
              onChange={handleFolderPicked}
            />
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="flex h-primary items-center gap-compact rounded-input bg-accent px-panel text-ui-body font-medium text-accent-fg hover:opacity-90"
            >
              {t("projects.newWorkspace")} <ChevronDown size={14} />
            </button>
            {dropdownOpen && (
              <div className="ui-popover absolute right-0 top-full z-20 mt-1 w-56 rounded-card p-compact">
                <button onClick={handleCreate} disabled={creating || importingFolder} className="flex h-control w-full items-center gap-2.5 rounded-input px-panel text-left text-ui-label text-text hover:bg-surface-2 disabled:opacity-60">
                  {creating ? <Loader2 size={15} className="animate-spin text-muted" /> : <Plus size={15} className="text-muted" />} {t("projects.newWorkspace")}
                </button>
                <button onClick={handleOpenFolder} disabled={creating || importingFolder} className="flex h-control w-full items-center gap-2.5 rounded-input px-panel text-left text-ui-label text-text hover:bg-surface-2 disabled:opacity-60">
                  {importingFolder ? <Loader2 size={15} className="animate-spin text-muted" /> : <FolderInput size={15} className="text-muted" />} {t("projects.openFolder")}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Demo cards (dismissible) */}
        {demos.filter(d => !dismissedDemos.has(d.name)).length > 0 && (
          <div className="mb-page flex flex-col gap-panel lg:flex-row">
            {demos.filter(d => !dismissedDemos.has(d.name)).map(d => (
              <article key={d.name} className="relative flex-1 group/demo">
                <button type="button" onClick={() => void installDemo(d.name)} disabled={installingDemo}
                  className="ui-card-accent flex w-full items-center gap-panel rounded-card p-card pr-10 text-left transition-all hover:border-accent/60 hover:shadow-pop disabled:cursor-wait disabled:opacity-60"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent/10 text-accent ring-1 ring-accent/20"><d.icon size={18} strokeWidth={1.75} /></span>
                  <span className="flex-1">
                    <span className="block font-medium text-text">{d.title}</span>
                    <span className="mt-0.5 block text-xs text-muted">{d.desc}</span>
                  </span>
                  <span className="rounded-full bg-accent/15 px-3 py-1 text-[11px] font-medium text-accent shrink-0">
                    {installingDemo ? t("projects.installing") : t("projects.tryDemo")}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => dismissDemo(d.name)}
                  aria-label={t("projects.dismissDemo", { name: d.title })}
                  className="absolute top-2 right-2 rounded p-1 text-muted/50 hover:text-muted hover:bg-surface-2 opacity-0 group-hover/demo:opacity-100 transition-opacity"
                >
                  <X size={13} />
                </button>
              </article>
            ))}
          </div>
        )}

        {/* Workspace cards */}
        {workspaces.length === 0 ? (
          <div className="text-center py-20">
            <FolderOpen size={48} className="mx-auto text-muted/40 mb-4" />
            <p className="text-muted text-sm">{t("projects.empty")}</p>
          </div>
        ) : (
          <>
            {/* Pinned section */}
            {pinnedWs.length > 0 && (
              <>
                <div className="mb-panel flex h-nav items-center gap-2">
                  <Pin size={13} className="text-accent" />
                  <span className="text-ui-caption font-medium uppercase tracking-wider text-muted">{t("projects.pinned")}</span>
                  <span className="text-[10px] text-muted/60 ml-1">{pinnedWs.length}</span>
                </div>
                <div className="mb-page grid grid-cols-1 gap-card sm:grid-cols-2 lg:grid-cols-4">
                  {pinnedWs.map(w => <WorkspaceCard key={w.path} w={w} {...{ pinned, togglePin, editingName, setEditingName, editValue, setEditValue, handleRename, handleDelete, nameInputRef, navigate, timeAgo }} />)}
                </div>
                {unpinnedWs.length > 0 && (
                  <div className="mb-page border-t border-faint" />
                )}
              </>
            )}

            {/* Unpinned grid */}
            {unpinnedWs.length > 0 && (
              <div className="grid grid-cols-1 gap-card sm:grid-cols-2 lg:grid-cols-4">
                {unpinnedWs.map(w => <WorkspaceCard key={w.path} w={w} {...{ pinned, togglePin, editingName, setEditingName, editValue, setEditValue, handleRename, handleDelete, nameInputRef, navigate, timeAgo }} />)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
    </ErrorBoundary>
  );
}

/* ── Workspace Card ── */

function WorkspaceCard({ w, pinned, togglePin, editingName, setEditingName, editValue, setEditValue, handleRename, handleDelete, nameInputRef, navigate, timeAgo }: {
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
}) {
  const { t } = useTranslation();
  const isPinned = pinned.has(w.path);

  const startEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingName(w.path);
    setEditValue(w.name);
    setTimeout(() => nameInputRef.current?.focus(), 50);
  };

  return (
    <div
      onClick={() => navigate(`/workspace/${encodeURIComponent(w.path)}`)}
      className={cn(
        "ui-card-interactive group relative cursor-pointer rounded-card p-card text-left",
        isPinned && "ring-1 ring-accent/30",
      )}
    >
      {/* Hover action buttons — bottom-right of card */}
      <div className="ui-popover absolute right-2 bottom-2 z-10 hidden items-center gap-0.5 rounded-input p-0.5 group-hover:flex"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={() => togglePin(w.path)}
          className={cn("rounded p-1.5 hover:bg-surface-2", isPinned ? "text-accent" : "text-muted hover:text-text")}
          title={isPinned ? t("projects.unpin") : t("projects.pin")}
        >
          {isPinned ? <Pin size={13} /> : <PinOff size={13} />}
        </button>
        <button
          onClick={startEdit}
          className="rounded p-1.5 text-muted hover:text-text hover:bg-surface-2"
          title={t("projects.rename")}
        >
          <Pencil size={13} />
        </button>
        <button
          onClick={() => handleDelete(w.path)}
          className="rounded p-1.5 text-muted hover:bg-error/10 hover:text-error"
          title={t("projects.deleteTitle")}
        >
          <Trash2 size={13} />
        </button>
      </div>

      <div className="mb-panel flex items-start justify-between">
        <FolderOpen size={22} className="text-accent/60" />
        <span className="text-ui-caption text-muted/75">{timeAgo(w.last_modified)}</span>
      </div>

      {editingName === w.path ? (
        <input
          ref={nameInputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
            if (e.key === "Escape") setEditingName(null);
          }}
          onBlur={() => handleRename(w.path)}
          onClick={(e) => e.stopPropagation()}
          placeholder={w.name}
          className="rounded-input border border-accent bg-surface px-2 py-0.5 text-sm font-medium text-text outline-none w-full"
        />
      ) : (
        <h3 className="text-sm font-medium text-text truncate">{w.name}</h3>
      )}

      <div className="mt-2 flex items-center gap-compact text-ui-caption text-muted">
        <MessageSquare size={12} /> <span>{t("projects.sessionCount", { count: w.session_count })}</span>
      </div>
    </div>
  );
}
