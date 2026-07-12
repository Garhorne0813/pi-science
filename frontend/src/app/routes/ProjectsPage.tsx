import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FolderOpen, Plus, Loader2, MessageSquare, FolderInput, ChevronDown } from "lucide-react";
import { cn } from "../../lib/cn";

interface Workspace {
  name: string;
  path: string;
  session_count: number;
  last_modified: string;
}

export function ProjectsPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const dirInputRef = useRef<HTMLInputElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const loadWorkspaces = async () => {
    try {
      const res = await fetch("/api/workspaces");
      setWorkspaces(await res.json());
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { loadWorkspaces(); }, []);

  const handleCreate = async () => {
    setCreating(true); setDropdownOpen(false);
    try {
      const name = "Untitled Workspace";
      const res = await fetch("/api/workspaces", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      if (res.ok) {
        await loadWorkspaces();
        // Find the new card and start editing its name
        const updated = await fetch("/api/workspaces").then(r => r.json());
        const newest = updated.find((w: Workspace) => w.name === name);
        if (newest) {
          setEditingName(newest.path);
          setEditValue("");
          setTimeout(() => nameInputRef.current?.focus(), 100);
        }
      }
    } catch (e) { console.error(e); }
    finally { setCreating(false); }
  };

  const handleRename = async (oldPath: string) => {
    const newName = editValue.trim();
    if (!newName || newName === oldPath.split("/").pop()) {
      setEditingName(null);
      return;
    }
    try {
      await fetch("/api/workspaces/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: oldPath, name: newName }),
      });
    } catch (e) { console.error(e); }
    setEditingName(null);
    await loadWorkspaces();
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
      const res = await fetch("/api/workspaces/open", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
      });
      if (res.ok) {
        const w = await res.json();
        navigate(`/workspace/${encodeURIComponent(w.path)}`);
      }
    } catch (e) { console.error(e); }
  };

  const timeAgo = (d: string) => {
    const diff = Date.now() - new Date(d).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    if (mins < 1440) return `${Math.floor(mins / 60)}h ago`;
    return `${Math.floor(mins / 1440)}d ago`;
  };

  if (loading) return <div className="flex items-center justify-center h-full"><Loader2 size={24} className="animate-spin text-muted" /></div>;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[900px] px-8 py-12">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="font-serif text-2xl text-text">Projects</h1>
            <p className="mt-1 text-sm text-muted">{workspaces.length} workspace{workspaces.length !== 1 ? "s" : ""}</p>
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
              New Workspace <ChevronDown size={14} />
            </button>
            {dropdownOpen && (
              <div className="absolute right-0 top-full mt-1 z-20 w-56 rounded-card border border-border bg-surface p-1.5 shadow-pop">
                <button onClick={handleCreate} disabled={creating} className="flex items-center gap-2.5 rounded-input px-3 py-2 text-[13px] text-text hover:bg-surface-2 w-full text-left">
                  {creating ? <Loader2 size={15} className="animate-spin text-muted" /> : <Plus size={15} className="text-muted" />} New Workspace
                </button>
                <button onClick={handleOpenFolder} className="flex items-center gap-2.5 rounded-input px-3 py-2 text-[13px] text-text hover:bg-surface-2 w-full text-left">
                  <FolderInput size={15} className="text-muted" /> Open Folder
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Cards */}
        {workspaces.length === 0 ? (
          <div className="text-center py-20">
            <FolderOpen size={48} className="mx-auto text-muted/40 mb-4" />
            <p className="text-muted text-sm">No workspaces yet. Create one to get started.</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4">
            {workspaces.map((w) => (
              <button key={w.path} onClick={() => navigate(`/workspace/${encodeURIComponent(w.path)}`)} className={cn("rounded-card border border-border bg-surface p-5 text-left shadow-card", "hover:border-accent/40 hover:shadow-pop transition-all")}>
                <div className="flex items-start justify-between mb-3">
                  <FolderOpen size={28} className="text-accent/60" />
                  <span className="text-[10px] text-muted/60">{timeAgo(w.last_modified)}</span>
                </div>
                {editingName === w.path ? (
                  <input
                    ref={nameInputRef}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") handleRename(w.path); if (e.key === "Escape") setEditingName(null); }}
                    onBlur={() => handleRename(w.path)}
                    placeholder={w.name}
                    onClick={(e) => e.stopPropagation()}
                    className="rounded-input border border-accent bg-surface px-2 py-0.5 text-sm font-medium text-text outline-none w-full"
                  />
                ) : (
                  <h3 className="font-medium text-text truncate">{w.name}</h3>
                )}
                <div className="flex items-center gap-1.5 mt-2 text-xs text-muted">
                  <MessageSquare size={12} /> <span>{w.session_count} session{w.session_count !== 1 ? "s" : ""}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
