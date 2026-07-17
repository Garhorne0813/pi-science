import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { FolderOpen, File, ChevronRight, RefreshCw, Trash2, Copy, ArrowUp } from "lucide-react";
import { useUiStore } from "../../lib/store";
import { fileInspectorForPath } from "../../lib/artifacts";

interface DirEntry {
  path: string; name: string; isDir: boolean; size: number; modified: number;
}

interface Breadcrumb {
  name: string; path: string;
}

export function FilesPage() {
  const { cwd: rawCwd } = useParams<{ cwd: string }>();
  const workspaceCwd = rawCwd ? decodeURIComponent(rawCwd) : ".";
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [subdir, setSubdir] = useState("");
  const [loading, setLoading] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ entry: DirEntry; x: number; y: number } | null>(null);
  const openInspector = useUiStore((s) => s.openInspector);

  const loadFiles = useCallback(async (dir: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ cwd: workspaceCwd });
      if (dir) params.set("subdir", dir);
      const [filesRes, bcRes] = await Promise.all([
        fetch(`/api/files?${params}`),
        fetch(`/api/files/breadcrumbs?cwd=${encodeURIComponent(workspaceCwd)}&subdir=${encodeURIComponent(dir)}`),
      ]);
      setEntries(await filesRes.json());
      setBreadcrumbs(await bcRes.json());
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [workspaceCwd]);

  useEffect(() => {
    void loadFiles(subdir);
  }, [loadFiles, subdir]);

  useEffect(() => {
    const closeContextMenu = () => setContextMenu(null);
    document.addEventListener("click", closeContextMenu);
    return () => document.removeEventListener("click", closeContextMenu);
  }, []);

  const handleClick = (entry: DirEntry) => {
    if (entry.isDir) {
      setSubdir(entry.path);
    } else {
      openInspector(fileInspectorForPath(entry.path, entry.name, undefined, workspaceCwd));
    }
  };

  const handleDelete = async (entry: DirEntry) => {
    try {
      await fetch(`/api/files/${encodeURIComponent(entry.path)}?cwd=${encodeURIComponent(workspaceCwd)}`, { method: "DELETE" });
      void loadFiles(subdir);
    } catch (e) { console.error(e); }
    setContextMenu(null);
  };

  const handleContextMenu = (e: React.MouseEvent, entry: DirEntry) => {
    e.preventDefault();
    setContextMenu({ entry, x: e.clientX, y: e.clientY });
  };

  const copyPath = (text: string) => {
    navigator.clipboard.writeText(text);
    setContextMenu(null);
  };

  const humanSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1048576).toFixed(1)} MB`;
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[900px] px-8 py-8">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="font-serif text-xl text-text">Files</h1>
            {/* Breadcrumbs */}
            <div className="flex items-center gap-1 mt-2 text-sm text-muted">
              <button onClick={() => setSubdir("")} className="hover:text-text">Workspace</button>
              {breadcrumbs.map((bc) => (
                <span key={bc.path} className="flex items-center gap-1">
                  <ChevronRight size={12} />
                  <button onClick={() => setSubdir(bc.path)} className="hover:text-text">{bc.name}</button>
                </span>
              ))}
            </div>
          </div>
          <button onClick={() => void loadFiles(subdir)} className="rounded-input px-2 py-1 text-xs text-muted hover:text-text hover:bg-surface-2 flex items-center gap-1">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
        </div>

        {/* Subdirectory navigation */}
        {subdir && (
          <button onClick={() => { const parts = subdir.split("/"); parts.pop(); setSubdir(parts.join("/")); }}
            className="mb-3 rounded-input px-2 py-1 text-xs text-link hover:bg-surface-2 flex items-center gap-1">
            <ArrowUp size={12} /> Up
          </button>
        )}

        {loading ? (
          <div className="text-sm text-muted py-8 text-center">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="text-center py-16">
            <FolderOpen size={40} className="mx-auto text-muted/30 mb-3" />
            <p className="text-sm text-muted">Empty directory</p>
          </div>
        ) : (
          <div className="rounded-card border border-border bg-surface overflow-hidden">
            {entries.map((e) => (
              <div key={e.path} onContextMenu={(ev) => handleContextMenu(ev, e)}
                className="group flex items-center gap-3 px-4 py-2.5 border-b border-faint last:border-b-0 hover:bg-surface-2 cursor-pointer text-sm">
                <button onClick={() => handleClick(e)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                  {e.isDir ? <FolderOpen size={16} className="text-accent/60 shrink-0" /> : <File size={16} className="text-muted shrink-0" />}
                  <span className="truncate text-text">{e.name}</span>
                  <span className="text-xs text-muted shrink-0 ml-auto">{e.isDir ? "—" : humanSize(e.size)}</span>
                </button>
                <button onClick={(ev) => { ev.stopPropagation(); handleDelete(e); }}
                  className="shrink-0 rounded p-1 text-muted hover:text-error hover:bg-error/10 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div className="fixed z-50 rounded-card border border-border bg-surface p-1 shadow-pop min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button onClick={() => copyPath(contextMenu.entry.name)} className="flex items-center gap-2 rounded-input px-3 py-1.5 text-[12px] text-text hover:bg-surface-2 w-full text-left">
            <Copy size={12} className="text-muted" /> Copy Name
          </button>
          <button onClick={() => copyPath(contextMenu.entry.path)} className="flex items-center gap-2 rounded-input px-3 py-1.5 text-[12px] text-text hover:bg-surface-2 w-full text-left">
            <Copy size={12} className="text-muted" /> Copy Path
          </button>
          <button onClick={() => handleDelete(contextMenu.entry)} className="flex items-center gap-2 rounded-input px-3 py-1.5 text-[12px] text-error hover:bg-error/10 w-full text-left">
            <Trash2 size={12} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}
