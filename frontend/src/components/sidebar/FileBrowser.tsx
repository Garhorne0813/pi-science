import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, File, ChevronRight, ChevronDown, RefreshCw, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "../../lib/ui";
import { fileInspectorForPath } from "../../lib/artifacts";
import { workspaceFiles } from "../../lib/workspace";
import { useFeedback } from "../feedback/feedback-context";
import { FileContextMenu, type ContextPoint, type FileListEntry } from "./FileContextMenu";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { Icon } from "../ui/Icon";

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
  const openFoldersRef = useRef<Set<string>>(new Set());
  // Guards async results: any newer load/toggle invalidates older in-flight
  // requests (workspace switch, rapid toggles, revision bumps).
  const requestTokenRef = useRef(0);
  // The `work/` folder auto-opens only once per workspace, so a later revision
  // refresh does not fight a user who deliberately closed it.
  const initializedRef = useRef(false);
  const openInspector = useUiStore((s) => s.openInspector);
  const addWorkspaceReference = useUiStore((s) => s.addWorkspaceReference);
  const fileRevision = useRuntimeStore((s) => s.fileRevision);

  const loadFiles = useCallback(async (signal?: AbortSignal, quiet = false) => {
    const token = ++requestTokenRef.current;
    if (!quiet) setLoading(true);
    try {
      const rootEntries = await workspaceFiles.sidebar(cwd, signal);
      if (token !== requestTokenRef.current || signal?.aborted) return;
      setEntries(rootEntries);

      // Re-read every folder that is currently expanded (not just work/), so
      // files created by a finished turn show up everywhere the user is looking.
      const dirs = [...openFoldersRef.current];
      const results = await Promise.all(dirs.map(async (dir) => {
        try {
          return { dir, result: await workspaceFiles.directory(cwd, dir, signal) };
        } catch (error) {
          return { dir, error: error instanceof Error ? error.message : String(error) };
        }
      }));
      if (token !== requestTokenRef.current || signal?.aborted) return;
      setFolderStates((prev) => {
        const next = new Map(prev);
        for (const item of results) {
          if ("result" in item && item.result) next.set(item.dir, { entries: item.result.entries, loading: false, error: null });
          else next.set(item.dir, { entries: prev.get(item.dir)?.entries ?? [], loading: false, error: "error" in item ? item.error : "unknown error" });
        }
        return next;
      });

      // First load per workspace: surface the `work/` folder automatically.
      if (!initializedRef.current) {
        initializedRef.current = true;
        const work = rootEntries.find((e) => e.isDir && e.name === "work");
        if (work && !openFoldersRef.current.has(work.path)) {
          setOpenFolders((prev) => { const next = new Set(prev); next.add(work.path); return next; });
          openFoldersRef.current.add(work.path);
          setFolderStates((prev) => { const next = new Map(prev); next.set(work.path, { entries: [], loading: true, error: null }); return next; });
          try {
            const result = await workspaceFiles.directory(cwd, work.path, signal);
            if (token !== requestTokenRef.current || signal?.aborted) return;
            setFolderStates((prev) => {
              const next = new Map(prev);
              if (!next.get(work.path)?.loading) return next;
              next.set(work.path, { entries: result.entries, loading: false, error: null });
              return next;
            });
          } catch (error) {
            if (token !== requestTokenRef.current || signal?.aborted) return;
            setFolderStates((prev) => {
              const next = new Map(prev);
              if (!next.get(work.path)?.loading) return next;
              next.set(work.path, { entries: [], loading: false, error: error instanceof Error ? error.message : String(error) });
              return next;
            });
          }
        }
      }
    } catch (error) {
      if (!signal?.aborted) toast(error instanceof Error ? error.message : t("files.loadError"), "error");
    } finally { if (token === requestTokenRef.current && !quiet) setLoading(false); }
  }, [cwd, t, toast]);

  // Reset per-workspace state when the cwd changes.
  useEffect(() => {
    initializedRef.current = false;
    requestTokenRef.current += 1;
    openFoldersRef.current = new Set();
    setOpenFolders(new Set());
    setFolderStates(new Map());
  }, [cwd]);

  useEffect(() => {
    const controller = new AbortController();
    void loadFiles(controller.signal);
    return () => controller.abort();
  }, [fileRevision, loadFiles]);

  // Polling fallback while the browser tab is visible: catches files created
  // by kernels or external tools that never emitted a terminal event. Quiet so
  // repeated refreshes never flash the loading indicator.
  useEffect(() => {
    if (!expanded) return;
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadFiles(undefined, true);
    }, 2_000);
    return () => window.clearInterval(id);
  }, [expanded, loadFiles]);

  const handleClick = (entry: FileListEntry) => {
    if (entry.isDir) {
      toggleFolder(entry.path);
      return;
    }
    openInspector(fileInspectorForPath(entry.path, entry.name, undefined, cwd));
  };

  const toggleFolder = useCallback(async (dirPath: string) => {
    const isClosing = openFoldersRef.current.has(dirPath);
    setOpenFolders((prev) => {
      const next = new Set(prev);
      if (isClosing) next.delete(dirPath); else next.add(dirPath);
      openFoldersRef.current = next;
      return next;
    });
    if (isClosing) {
      // Dropping the cached state means reopening always re-reads from the
      // server instead of reusing a possibly stale listing.
      setFolderStates((prev) => { const next = new Map(prev); next.delete(dirPath); return next; });
      return;
    }
    const token = ++requestTokenRef.current;
    setFolderStates((prev) => { const next = new Map(prev); next.set(dirPath, { entries: prev.get(dirPath)?.entries ?? [], loading: true, error: null }); return next; });
    try {
      const result = await workspaceFiles.directory(cwd, dirPath);
      if (token !== requestTokenRef.current) return;
      setFolderStates((prev) => {
        const next = new Map(prev);
        const current = next.get(dirPath);
        if (!current || !current.loading) return next;
        next.set(dirPath, { entries: result.entries, loading: false, error: null });
        return next;
      });
    } catch (error) {
      if (token !== requestTokenRef.current) return;
      setFolderStates((prev) => {
        const next = new Map(prev);
        const current = next.get(dirPath);
        if (!current || !current.loading) return next;
        next.set(dirPath, { entries: [], loading: false, error: error instanceof Error ? error.message : String(error) });
        return next;
      });
    }
  }, [cwd]);

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
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => { setExpanded(!expanded); if (!expanded) void loadFiles(); }}
          className="flex h-tool min-w-0 flex-1 items-center gap-1.5 px-2 text-ui-caption font-medium uppercase tracking-wider text-muted hover:text-text"
        >
          <Icon icon={expanded ? ChevronDown : ChevronRight} size="xs" />
          <span className="truncate">{t("nav.files")}</span>
        </button>
        <button
          type="button"
          aria-label={t("files.refresh", { defaultValue: "Refresh files" })}
          title={t("files.refresh", { defaultValue: "Refresh files" })}
          onClick={refreshFiles}
          className="flex h-tool w-tool shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-hover hover:text-text"
        >
          <Icon icon={RefreshCw} size="xs" className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      {expanded && (
        <div className="mt-1 flex flex-col gap-0.5 max-h-72 overflow-y-auto">
          {loading && entries.length === 0 ? (
            <p className="px-2 text-ui-meta italic text-muted/60">{t("common.loading")}</p>
          ) : entries.length === 0 ? (
            <p className="px-2 text-ui-meta italic text-muted/60">{t("files.empty")}</p>
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
                    className="flex h-icon w-full items-center gap-2 truncate rounded px-2 text-left text-ui-caption text-text/80 hover:bg-surface-hover"
                    title={e.path}
                    style={{ paddingLeft: `${8 + e.depth * 12}px` }}
                  >
                    {e.isDir ? <Icon icon={openFolders.has(e.path) ? ChevronDown : ChevronRight} size="xs" className="shrink-0 text-muted" /> : null}
                    <Icon icon={e.isDir ? FolderOpen : File} size="sm" className="shrink-0 text-muted" />
                    <span className="truncate">{e.name}</span>
                    {isLoading && <Icon icon={Loader2} size="xs" className="ml-auto shrink-0 animate-spin text-muted" />}
                  </button>
                  {error && <p className="px-2 text-ui-micro italic text-error-text" style={{ paddingLeft: `${20 + e.depth * 12}px` }}>{error}</p>}
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
