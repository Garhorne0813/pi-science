import { useCallback, useEffect, useState } from "react";
import { FolderOpen, File, ChevronRight, ChevronDown, RefreshCw, Copy } from "lucide-react";
import { useUiStore } from "../../lib/store";
import { fileInspectorForPath } from "../../lib/artifacts";

interface DirEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export function FileBrowser({ cwd }: { cwd: string }) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ entry: DirEntry; x: number; y: number } | null>(null);
  const openInspector = useUiStore((s) => s.openInspector);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ cwd });
      const res = await fetch(`/api/files?${params}`);
      if (res.ok) {
        const data = await res.json();
        setEntries(Array.isArray(data) ? data.filter((e: DirEntry) => !e.name.startsWith(".")).slice(0, 30) : []);
      }
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
  }, [cwd]);

  useEffect(() => { void loadFiles(); }, [loadFiles]);
  useEffect(() => {
    const close = () => setContextMenu(null);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  const handleClick = (entry: DirEntry) => {
    if (entry.isDir) return;
    openInspector(fileInspectorForPath(entry.path, entry.name, undefined, cwd));
  };

  const handleContextMenu = (e: React.MouseEvent, entry: DirEntry) => {
    e.preventDefault();
    setContextMenu({ entry, x: e.clientX, y: e.clientY });
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setContextMenu(null);
  };

  return (
    <div className="border-t border-faint mt-2 pt-2">
      <div
        onClick={() => { setExpanded(!expanded); if (!expanded) void loadFiles(); }}
        className="flex items-center justify-between w-full px-2 py-1 text-xs font-medium uppercase tracking-wider text-muted hover:text-text cursor-pointer"
      >
        <span className="flex items-center gap-1.5">
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          Files
        </span>
        <span onClick={(e) => { e.stopPropagation(); void loadFiles(); }} className="hover:text-text cursor-pointer">
          <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
        </span>
      </div>
      {expanded && (
        <div className="mt-1 flex flex-col gap-0.5 max-h-48 overflow-y-auto">
          {loading && entries.length === 0 ? (
            <p className="px-2 text-[11px] text-muted/60 italic">Loading…</p>
          ) : entries.length === 0 ? (
            <p className="px-2 text-[11px] text-muted/60 italic">No files</p>
          ) : (
            entries.map((e) => (
              <button
                key={e.path}
                onClick={() => handleClick(e)}
                onContextMenu={(ev) => handleContextMenu(ev, e)}
                className="flex items-center gap-2 px-2 py-0.5 text-[12px] text-text/80 hover:bg-surface-2 rounded text-left truncate"
                title={e.path}
              >
                {e.isDir ? <FolderOpen size={12} className="text-muted shrink-0" /> : <File size={12} className="text-muted shrink-0" />}
                <span className="truncate">{e.name}</span>
              </button>
            ))
          )}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 rounded-card border border-border bg-surface p-1 shadow-pop min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button onClick={() => copyToClipboard(contextMenu.entry.name)} className="flex items-center gap-2 rounded-input px-3 py-1.5 text-[12px] text-text hover:bg-surface-2 w-full text-left">
            <Copy size={12} className="text-muted" /> Copy Name
          </button>
          <button onClick={() => copyToClipboard(contextMenu.entry.path)} className="flex items-center gap-2 rounded-input px-3 py-1.5 text-[12px] text-text hover:bg-surface-2 w-full text-left">
            <Copy size={12} className="text-muted" /> Copy Path
          </button>
        </div>
      )}
    </div>
  );
}
