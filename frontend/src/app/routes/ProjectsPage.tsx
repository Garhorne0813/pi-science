import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderOpen, Plus, Loader2, MessageSquare, FolderInput, ChevronDown, Pin, PinOff, Pencil, Trash2, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { useTranslation } from "react-i18next";
import { useFeedback } from "../../components/feedback/feedback-context";
import { apiRequest, invalidateApiCache } from "../../lib/api";

interface Workspace {
  name: string;
  path: string;
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

export function ProjectsPage() {
  const { t } = useTranslation();
  const { toast, confirm: confirmAction } = useFeedback();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [installingDemo, setInstallingDemo] = useState(false);
  // Pinned paths stored server-side in ~/.pi-science/pinned.json — shared across browsers
  const [pinned, setPinned] = useState<Set<string>>(new Set());
  const [dismissedDemos, setDismissedDemos] = useState<Set<string>>(loadDismissedDemos);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspaces(await apiRequest<Workspace[]>("/api/workspaces", { cacheTtlMs: 3000 }));
    } catch { toast(t("projects.loadError"), "error"); }
    finally { setLoading(false); }
  }, [t, toast]);

  const loadPinned = useCallback(async () => {
    try {
      const data = await apiRequest<{ paths?: string[] }>("/api/workspaces/pinned", { cacheTtlMs: 3000 });
      setPinned(new Set(data.paths || []));
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { void loadWorkspaces(); void loadPinned(); }, [loadPinned, loadWorkspaces]);

  // Safety: force loading off after 10s even if API never responds
  useEffect(() => {
    const t = setTimeout(() => setLoading(false), 10000);
    return () => clearTimeout(t);
  }, []);

  const handleCreate = async () => {
    setCreating(true); setDropdownOpen(false);
    try {
      const name = `Untitled Workspace ${crypto.randomUUID().slice(0, 8)}`;
      await apiRequest("/api/workspaces", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      invalidateApiCache("/api/workspaces");
      await loadWorkspaces();
      const updated = await apiRequest<Workspace[]>("/api/workspaces");
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
    if (!newName || newName === oldPath.split("/").pop()) {
      return;
    }
    try {
      await apiRequest("/api/workspaces/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: oldPath, name: newName }),
      });
      invalidateApiCache("/api/workspaces");
      toast(t("projects.renamed"), "success");
    } catch { toast(t("projects.renameError"), "error"); }
    await loadWorkspaces();
  };

  const handleDelete = async (path: string) => {
    const name = path.split("/").pop() || path;
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
        const next = new Set(pinned);
        next.delete(path);
        setPinned(next);
      }
      invalidateApiCache("/api/workspaces");
      await loadWorkspaces();
      toast(t("projects.deleted", { name }), "success");
    } catch { toast(t("projects.deleteError"), "error"); }
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
      setPinned(next);
      invalidateApiCache("/api/workspaces");
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
    const path = `~/pi-science-workspaces/${folderName}`;
    try {
      const w = await apiRequest<Workspace>("/api/workspaces/open", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
      });
      navigate(`/workspace/${encodeURIComponent(w.path)}`);
    } catch { toast(t("projects.openError"), "error"); }
  };

  const installDemo = async (name: string) => {
    setInstallingDemo(true);
    try {
      const w = await apiRequest<Workspace>(`/api/workspaces/demo?name=${name}`, { method: "POST" });
      navigate(`/workspace/${encodeURIComponent(w.path)}`);
    } catch { toast(t("projects.demoError"), "error"); }
    finally { setInstallingDemo(false); }
  };

  const timeAgo = (d: string) => {
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    return `${Math.floor(mins / 1440)}d ago`;
  };

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 size={24} className="animate-spin text-muted" /></div>;

  // Split into pinned & unpinned
  const pinnedWs = workspaces.filter(w => pinned.has(w.path));
  const unpinnedWs = workspaces.filter(w => !pinned.has(w.path));
  const demos = [
    { name: "molecules", icon: "🧬", title: "Molecular Playground", desc: "Lysozyme structure · Aspirin · Caffeine · Drug-likeness analysis" },
    { name: "climate", icon: "🌍", title: "Climate Trends", desc: "Global temperature anomaly data (NASA GISTEMP v4) with guided analysis" },
  ];

  return (
    <ErrorBoundary>
    <div className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[1200px] px-4 py-8 sm:px-6 lg:px-8 lg:py-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
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
              className="rounded-input bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg flex items-center gap-1.5 hover:opacity-90"
            >
              {t("projects.newWorkspace")} <ChevronDown size={14} />
            </button>
            {dropdownOpen && (
              <div className="absolute right-0 top-full mt-1 z-20 w-56 rounded-card border border-border bg-surface p-1.5 shadow-pop">
                <button onClick={handleCreate} disabled={creating} className="flex items-center gap-2.5 rounded-input px-3 py-2 text-[13px] text-text hover:bg-surface-2 w-full text-left">
                  {creating ? <Loader2 size={15} className="animate-spin text-muted" /> : <Plus size={15} className="text-muted" />} {t("projects.newWorkspace")}
                </button>
                <button onClick={handleOpenFolder} className="flex items-center gap-2.5 rounded-input px-3 py-2 text-[13px] text-text hover:bg-surface-2 w-full text-left">
                  <FolderInput size={15} className="text-muted" /> {t("projects.openFolder")}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Demo cards (dismissible) */}
        {demos.filter(d => !dismissedDemos.has(d.name)).length > 0 && (
          <div className="mb-6 flex flex-col gap-3 lg:flex-row">
            {demos.filter(d => !dismissedDemos.has(d.name)).map(d => (
              <article key={d.name} className="relative flex-1 group/demo">
                <button type="button" onClick={() => void installDemo(d.name)} disabled={installingDemo}
                  className="flex w-full items-center gap-3 rounded-card border border-accent/30 bg-accent/5 p-4 pr-10 text-left transition-all hover:border-accent/50 hover:shadow-pop disabled:cursor-wait disabled:opacity-60"
                >
                  <span className="text-2xl">{d.icon}</span>
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
                <div className="flex items-center gap-2 mb-3">
                  <Pin size={13} className="text-accent" />
                  <span className="text-xs font-medium uppercase tracking-wider text-muted">{t("projects.pinned")}</span>
                  <span className="text-[10px] text-muted/60 ml-1">{pinnedWs.length}</span>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4 mb-6">
                  {pinnedWs.map(w => <WorkspaceCard key={w.path} w={w} {...{ pinned, togglePin, editingName, setEditingName, editValue, setEditValue, handleRename, handleDelete, nameInputRef, navigate, timeAgo }} />)}
                </div>
                {unpinnedWs.length > 0 && (
                  <div className="border-t border-faint mb-6" />
                )}
              </>
            )}

            {/* Unpinned grid */}
            {unpinnedWs.length > 0 && (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
        "group relative rounded-card border border-border bg-surface p-4 text-left shadow-card cursor-pointer",
        "hover:border-accent/40 hover:shadow-pop transition-all",
        isPinned && "ring-1 ring-accent/30",
      )}
    >
      {/* Hover action buttons — bottom-right of card */}
      <div className="absolute right-2 bottom-2 hidden group-hover:flex items-center gap-0.5 bg-surface/95 rounded-input border border-border/60 p-0.5 shadow-card z-10"
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

      <div className="flex items-start justify-between mb-3">
        <FolderOpen size={22} className="text-accent/60" />
        <span className="text-[10px] text-muted/60">{timeAgo(w.last_modified)}</span>
      </div>

      {editingName === w.path ? (
        <input
          ref={nameInputRef}
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleRename(w.path); if (e.key === "Escape") setEditingName(null); }}
          onBlur={() => handleRename(w.path)}
          onClick={(e) => e.stopPropagation()}
          placeholder={w.name}
          className="rounded-input border border-accent bg-surface px-2 py-0.5 text-sm font-medium text-text outline-none w-full"
        />
      ) : (
        <h3 className="text-sm font-medium text-text truncate">{w.name}</h3>
      )}

      <div className="flex items-center gap-1.5 mt-2 text-[11px] text-muted">
        <MessageSquare size={12} /> <span>{t("projects.sessionCount", { count: w.session_count })}</span>
      </div>
    </div>
  );
}
