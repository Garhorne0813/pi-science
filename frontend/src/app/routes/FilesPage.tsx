import { ErrorState, inputClass } from "../../components/ui/controls";
import { useCallback, useEffect, useRef, useState } from "react";
import { FolderOpen, File, ChevronRight, Trash2, ArrowUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { copyTextToClipboard, useUiStore } from "../../lib/ui";
import { fileInspectorForPath } from "../../lib/artifacts";
import { absoluteWorkspacePath } from "../../lib/files/workspace-path";
import { workspaceFiles, type Breadcrumb } from "../../lib/workspace";
import { FileContextMenu, type ContextPoint, type FileListEntry } from "../../components/sidebar/FileContextMenu";
import { useFeedback } from "../../components/feedback/feedback-context";
import { WorkspacePage, WorkspacePageHeader, WorkspacePageRefreshButton } from "../../components/layout/WorkspacePage";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { useRequiredWorkspaceCwd } from "../../lib/workspace";

export function FilesPage() {
  const { t } = useTranslation();
  const { confirm, toast } = useFeedback();
  const workspaceCwd = useRequiredWorkspaceCwd();
  const notebookOnly = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("type") === "notebook";
  const [entries, setEntries] = useState<FileListEntry[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [subdir, setSubdir] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadedDir = useRef<string | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("name");
  const [loading, setLoading] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ entry: FileListEntry; point: ContextPoint } | null>(null);
  // Guards the polling fallback: a refresh for a previous subdir must never
  // overwrite entries for the current one (mirrors FileBrowser's token guard).
  const pollTokenRef = useRef(0);
  const openInspector = useUiStore((s) => s.openInspector);
  const addWorkspaceReference = useUiStore((s) => s.addWorkspaceReference);
  const fileRevision = useRuntimeStore((s) => s.fileRevision);
  const visibleEntries = entries.filter((entry) => (!notebookOnly || entry.isDir || entry.name.toLowerCase().endsWith(".ipynb")) && entry.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).sort((a, b) => Number(b.isDir) - Number(a.isDir) || (sort === "modified" ? b.modified - a.modified : sort === "type" ? a.name.split(".").pop()!.localeCompare(b.name.split(".").pop()!) : 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));

  const loadFiles = useCallback(async (dir: string, signal?: AbortSignal) => {
    setLoading(true);
    if (dir !== loadedDir.current) setEntries([]);
    try {
      const result = await workspaceFiles.directory(workspaceCwd, dir, signal);
      setEntries(result.entries);
      loadedDir.current = dir;
      setLoadError(null);
      setBreadcrumbs(result.breadcrumbs);
    } catch (error) {
      if (!signal?.aborted) setLoadError(error instanceof Error ? error.message : t("files.loadError"));
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [workspaceCwd, t]);

  useEffect(() => {
    const controller = new AbortController();
    void loadFiles(subdir, controller.signal);
    return () => controller.abort();
  }, [fileRevision, loadFiles, subdir]);

  // Polling fallback while this tab is visible: keeps the listing fresh when
  // files are created by kernels or external tools without a terminal event.
  // Quiet — only the first load shows the loading state, refreshes never flash.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const token = ++pollTokenRef.current;
      void workspaceFiles.refreshDirectory(workspaceCwd, subdir)
        .then((result) => {
          // Drop results that raced a directory switch (or unmount): the
          // current token only matches the newest poll cycle.
          if (token !== pollTokenRef.current) return;
          setLoadError(null);
          loadedDir.current = subdir;
          setEntries(result.entries);
          setBreadcrumbs(result.breadcrumbs);
        })
        .catch((error) => { if (token === pollTokenRef.current) setLoadError(error instanceof Error ? error.message : t("files.loadError")); });
    }, 2_000);
    return () => { pollTokenRef.current += 1; window.clearInterval(id); };
  }, [workspaceCwd, subdir, t]);

  const refreshFiles = () => {
    workspaceFiles.invalidate();
    void loadFiles(subdir);
  };

  const handleClick = (entry: FileListEntry) => {
    if (entry.isDir) {
      setSubdir(entry.path);
    } else {
      openInspector(fileInspectorForPath(entry.path, entry.name, undefined, workspaceCwd));
    }
  };

  const handleDelete = async (entry: FileListEntry) => {
    setContextMenu(null);
    const approved = await confirm({
      title: entry.isDir ? t("files.deleteFolderTitle") : t("files.deleteFileTitle"),
      message: t("files.deleteConfirm", { name: entry.name }),
      confirmLabel: t("common.delete"),
      destructive: true,
    });
    if (!approved) return;
    try {
      await workspaceFiles.remove(workspaceCwd, entry.path);
      await loadFiles(subdir);
      toast(t("files.deleted", { name: entry.name }), "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : t("files.deleteError"), "error");
    }
  };

  const handleContextMenu = (e: React.MouseEvent, entry: FileListEntry) => {
    e.preventDefault();
    setContextMenu({ entry, point: { x: e.clientX, y: e.clientY } });
  };

  const copyPath = async (text: string) => {
    // Close the menu before the clipboard round-trip so a slow write cannot
    // unmount a menu the user reopened in the meantime.
    setContextMenu(null);
    const copied = await copyTextToClipboard(text);
    toast(t(copied ? "files.copied" : "files.copyFailed"), copied ? "success" : "error");
  };

  const referenceEntry = (entry: FileListEntry) => {
    addWorkspaceReference({ cwd: workspaceCwd, path: entry.path, name: entry.name, isDir: entry.isDir });
    setContextMenu(null);
  };

  return (
    <WorkspacePage>
      <WorkspacePageHeader
        title={t("nav.files")}
        description={
          <div className="flex flex-wrap items-center gap-1">
              <button onClick={() => setSubdir("")} className="hover:text-text">{t("files.workspace")}</button>
              {breadcrumbs.map((bc) => (
                <span key={bc.path} className="flex items-center gap-1">
                  <ChevronRight size={12} />
                  <button onClick={() => setSubdir(bc.path)} className="hover:text-text">{bc.name}</button>
                </span>
              ))}
          </div>
        }
        actions={
          <WorkspacePageRefreshButton label={t("common.refresh")} loading={loading} onClick={refreshFiles} />
        }
      />

      <div className="mt-6">
        {loadError && <ErrorState retry={refreshFiles} retryLabel={t("common.retry")} busy={loading}>{t("files.loadError")}{entries.length > 0 && <p>{t("common.refreshFailed")}</p>}<details className="mt-2 text-ui-caption"><summary>{t("runs.details")}</summary>{loadError}</details></ErrorState>}
        <div className="my-panel flex flex-wrap gap-2"><input aria-label={t("files.search")} placeholder={t("files.search")} value={search} onChange={(e) => setSearch(e.target.value)} className={inputClass + " flex-1"} /><select aria-label={t("files.sort")} value={sort} onChange={(e) => setSort(e.target.value)} className={inputClass}><option value="name">{t("files.sortName")}</option><option value="type">{t("files.sortType")}</option><option value="modified">{t("files.sortModified")}</option></select></div>
        {/* Subdirectory navigation */}
        {subdir && (
          <button onClick={() => { const parts = subdir.split("/"); parts.pop(); setSubdir(parts.join("/")); }}
            className="mb-3 rounded-input px-2 py-1 text-xs text-link hover:bg-surface-2 flex items-center gap-1">
            <ArrowUp size={12} /> {t("files.up")}
          </button>
        )}

        {loading && entries.length === 0 ? (
          <div className="text-sm text-muted py-8 text-center">{t("common.loading")}</div>
        ) : loadError && entries.length === 0 ? null : visibleEntries.length === 0 ? (
          <div className="text-center py-16">
            <FolderOpen size={40} className="mx-auto text-muted/30 mb-3" />
            <p className="text-sm text-muted">{t(search ? "files.noMatches" : "files.empty")}</p>
          </div>
        ) : (
          <div className="ui-card-flat overflow-hidden rounded-card">
            {visibleEntries.map((e) => (
              <div key={e.path} onContextMenu={(ev) => handleContextMenu(ev, e)}
                className="group flex items-center gap-3 pr-4 border-b border-faint last:border-b-0 hover:bg-surface-2 text-sm">
                <button onClick={() => handleClick(e)} className="flex self-stretch items-center gap-3 flex-1 min-w-0 py-3 pl-4 text-left" title={e.name} aria-label={e.name}>
                  {e.isDir ? <FolderOpen size={16} className="text-accent/60 shrink-0" /> : <File size={16} className="text-muted shrink-0" />}
                  <span className="min-w-0 flex-1 break-all text-text">{e.name}</span>
                  <time className="hidden shrink-0 text-ui-caption text-muted lg:block" title={t("files.modified")}>{new Date(e.modified * 1000).toLocaleDateString()}</time>
                  <span className="text-xs text-muted shrink-0 ml-auto">{e.isDir ? "—" : workspaceFiles.formatSize(e.size)}</span>
                </button>
                <button onClick={(ev) => { ev.stopPropagation(); handleDelete(e); }}
                  title={t("common.delete") + ": " + e.name} className="flex h-control w-control shrink-0 items-center justify-center rounded-input text-muted hover:text-error-text hover:bg-error/10">
                  <Trash2 size={14} /><span className="sr-only">{t("common.delete")}</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && <FileContextMenu entry={contextMenu.entry} point={contextMenu.point} onClose={() => setContextMenu(null)} onReference={() => referenceEntry(contextMenu.entry)} onCopy={(text) => void copyPath(text)} onCopyAbsolutePath={() => void copyPath(absoluteWorkspacePath(workspaceCwd, contextMenu.entry.path))} onDelete={() => void handleDelete(contextMenu.entry)} />}
    </WorkspacePage>
  );
}
