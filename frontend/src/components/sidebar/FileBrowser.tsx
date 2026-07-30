import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderOpen, File, ChevronRight, ChevronDown, RefreshCw, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "../../lib/store";
import { fileInspectorForPath } from "../../lib/artifacts";
import { workspaceFiles } from "../../lib/workspace-files";
import { useFeedback } from "../feedback/feedback-context";
import { FileContextMenu, type ContextPoint, type FileListEntry } from "./FileContextMenu";
import { useRuntimeStore } from "../../lib/runtime-store";

interface DirState { entries: FileListEntry[]; loading: boolean; error: string | null }

export function FileBrowser({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const { confirm, toast } = useFeedback();
  const [entries, setEntries] = useState<FileListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ entry: FileListEntry; point: ContextPoint } | null>(null);
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [folderStates, setFolderStates] = useState<Map<string, DirState>>(new Map());
  const openInspector = useUiStore((s) => s.openInspector);
  const addWorkspaceReference = useUiStore((s) => s.addWorkspaceReference);
  const fileRevision = useRuntimeStore((s) => s.fileRevision);

  const loadFiles = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const rootEntries = await workspaceFiles.sidebar(cwd, signal);
      setEntries(rootEntries);
      const work = rootEntries.find((e) => e.isDir && e.name === "work");
      if (work) {
        setOpenFolders((prev) => { const next = new Set(prev); next.add(work.path); return next; });
        setFolderStates((prev) => { const next = new Map(prev); next.set(work.path, { entries: [], loading: true, error: null }); return next; });
        try {
          const result = await workspaceFiles.directory(cwd, work.path);
          setFolderStates((prev) => {
            const next = new Map(prev);
            if (!next.get(work.path)?.loading) return next;
            next.set(work.path, { entries: result.entries, loading: false, error: null });
            return next;
          });
        } catch (error) {
          setFolderStates((prev) => {
            const next = new Map(prev);
            if (!next.get(work.path)?.loading) return next;
            next.set(work.path, { entries: [], loading: false, error: error instanceof Error ? error.message : String(error) });
            return next;
          });
        }
      }
    } catch (error) {
      if (!signal?.aborted) toast(error instanceof Error ? error.message : t("files.loadError"), "error");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [cwd, t, toast]);

  useEffect(() => {
    const controller = new AbortController();
    void loadFiles(controller.signal);
    return () => controller.abort();
  }, [fileRevision, loadFiles]);

  const handleClick = (entry: FileListEntry) => {
    if (entry.isDir) {
      toggleFolder(entry.path);
      return;
    }
    openInspector(fileInspectorForPath(entry.path, entry.name, undefined, cwd));
  };

  const toggleFolder = useCallback(async (dirPath: string) => {
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) { next.delete(dirPath); return next; }
      next.add(dirPath);
      return next;
    });
    const alreadyLoaded = folderStates.has(dirPath);
    if (!alreadyLoaded) {
      setFolderStates((prev) => { const next = new Map(prev); next.set(dirPath, { entries: [], loading: true, error: null }); return next; });
      try {
        const result = await workspaceFiles.directory(cwd, dirPath);
        setFolderStates((prev) => {
          const next = new Map(prev);
          const current = next.get(dirPath);
          // If the folder was closed and reopened while the request was in flight, keep loading.
          if (!current || !current.loading) return next;
          next.set(dirPath, { entries: result.entries, loading: false, error: null });
          return next;
        });
      } catch (error) {
        setFolderStates((prev) => {
          const next = new Map(prev);
          const current = next.get(dirPath);
          if (!current || !current.loading) return next;
          next.set(dirPath, { entries: [], loading: false, error: error instanceof Error ? error.message : String(error) });
          return next;
        });
      }
    }
  }, [cwd, folderStates]);

  const folderEntries = useMemo(() => {
    const seen = new Set<string>();
    const build = (items: FileListEntry[], depth: number): (FileListEntry & { depth: number })[] => {
      const row: (FileListEntry & { depth: number })[] = [];
      for (const entry of items) {
        if (seen.has(entry.path)) continue;
        seen.add(entry.path);
        row.push({ ...entry, depth });
        if (entry.isDir && openFolders.has(entry.path)) {
          const state = folderStates.get(entry.path);
          if (state && !state.loading && !state.error) row.push(...build(state.entries, depth + 1));
        }
      }
      return row;
    };
    return build(entries, 0);
  }, [entries, openFolders, folderStates]);

  const refreshFiles = () => {
    workspaceFiles.invalidate();
    void loadFiles();
  };

  const handleContextMenu = (e: React.MouseEvent, entry: FileListEntry) => {
    e.preventDefault();
    setContextMenu({ entry, point: { x: e.clientX, y: e.clientY } });
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    toast(t("files.copied"), "success");
    setContextMenu(null);
  };

  const referenceEntry = (entry: FileListEntry) => {
    addWorkspaceReference({ cwd, path: entry.path, name: entry.name, isDir: entry.isDir });
    setContextMenu(null);
  };

  const deleteEntry = async (entry: FileListEntry) => {
    setContextMenu(null);
    const approved = await confirm({ title: entry.isDir ? t("files.deleteFolderTitle") : t("files.deleteFileTitle"), message: t("files.deleteConfirm", { name: entry.name }), confirmLabel: t("common.delete"), destructive: true });
    if (!approved) return;
    try {
      await workspaceFiles.remove(cwd, entry.path);
      await loadFiles();
      toast(t("files.deleted", { name: entry.name }), "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : t("files.deleteError"), "error");
    }
  };

  return (
    <div className="border-t border-faint mt-2 pt-2">
      <div
        onClick={() => { setExpanded(!expanded); if (!expanded) void loadFiles(); }}
        className="flex items-center justify-between w-full px-2 py-1 text-xs font-medium uppercase tracking-wider text-muted hover:text-text cursor-pointer"
      >
        <span className="flex items-center gap-1.5">
          {expanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
          {t("nav.files")}
        </span>
        <span onClick={(e) => { e.stopPropagation(); refreshFiles(); }} className="hover:text-text cursor-pointer">
          <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
        </span>
      </div>
      {expanded && (
        <div className="mt-1 flex flex-col gap-0.5 max-h-32 overflow-y-auto">
          {loading && entries.length === 0 ? (
            <p className="px-2 text-[11px] text-muted/60 italic">{t("common.loading")}</p>
          ) : entries.length === 0 ? (
            <p className="px-2 text-[11px] text-muted/60 italic">{t("files.empty")}</p>
          ) : (
            folderEntries.map((e) => {
              const state = folderStates.get(e.path);
              const isLoading = state?.loading;
              const error = state?.error;
              return (
                <div key={e.path}>
                  <button
                    onClick={() => handleClick(e)}
                    onContextMenu={(ev) => handleContextMenu(ev, e)}
                    className="flex items-center gap-2 px-2 py-0.5 text-[12px] text-text/80 hover:bg-surface-2 rounded text-left truncate w-full"
                    title={e.path}
                    style={{ paddingLeft: `${8 + e.depth * 12}px` }}
                  >
                    {e.isDir && openFolders.has(e.path) ? <ChevronDown size={10} className="text-muted shrink-0" /> : e.isDir ? <ChevronRight size={10} className="text-muted shrink-0" /> : null}
                    {e.isDir ? <FolderOpen size={12} className="text-muted shrink-0" /> : <File size={12} className="text-muted shrink-0" />}
                    <span className="truncate">{e.name}</span>
                    {isLoading && <Loader2 size={10} className="animate-spin text-muted shrink-0 ml-auto" />}
                  </button>
                  {error && <p className="px-2 text-[10px] text-error/80 italic" style={{ paddingLeft: `${20 + e.depth * 12}px` }}>{error}</p>}
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && <FileContextMenu entry={contextMenu.entry} point={contextMenu.point} onClose={() => setContextMenu(null)} onReference={() => referenceEntry(contextMenu.entry)} onCopy={(text) => void copyToClipboard(text)} onDelete={() => void deleteEntry(contextMenu.entry)} />}
    </div>
  );
}
