import { useCallback, useEffect, useState } from "react";
import { FolderOpen, File, ChevronRight, Trash2, ArrowUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "../../lib/store";
import { fileInspectorForPath } from "../../lib/artifacts";
import { workspaceFiles, type Breadcrumb } from "../../lib/workspace-files";
import { FileContextMenu, type ContextPoint, type FileListEntry } from "../../components/sidebar/FileContextMenu";
import { useFeedback } from "../../components/feedback/feedback-context";
import { WorkspacePage, WorkspacePageHeader, WorkspacePageRefreshButton } from "../../components/layout/WorkspacePage";
import { useRuntimeStore } from "../../lib/runtime-store";
import { useRequiredWorkspaceCwd } from "../../lib/workspace-context";

export function FilesPage() {
  const { t } = useTranslation();
  const { confirm, toast } = useFeedback();
  const workspaceCwd = useRequiredWorkspaceCwd();
  const [entries, setEntries] = useState<FileListEntry[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [subdir, setSubdir] = useState("");
  const [loading, setLoading] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ entry: FileListEntry; point: ContextPoint } | null>(null);
  const openInspector = useUiStore((s) => s.openInspector);
  const addWorkspaceReference = useUiStore((s) => s.addWorkspaceReference);
  const fileRevision = useRuntimeStore((s) => s.fileRevision);

  const loadFiles = useCallback(async (dir: string, signal?: AbortSignal) => {
    setLoading(true);
    try {
      const result = await workspaceFiles.directory(workspaceCwd, dir, signal);
      setEntries(result.entries);
      setBreadcrumbs(result.breadcrumbs);
    } catch (error) {
      if (!signal?.aborted) toast(error instanceof Error ? error.message : t("files.loadError"), "error");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [workspaceCwd, t, toast]);

  useEffect(() => {
    const controller = new AbortController();
    void loadFiles(subdir, controller.signal);
    return () => controller.abort();
  }, [fileRevision, loadFiles, subdir]);

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
    await navigator.clipboard.writeText(text);
    toast(t("files.copied"), "success");
    setContextMenu(null);
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
          <div className="flex items-center gap-1">
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
        {/* Subdirectory navigation */}
        {subdir && (
          <button onClick={() => { const parts = subdir.split("/"); parts.pop(); setSubdir(parts.join("/")); }}
            className="mb-3 rounded-input px-2 py-1 text-xs text-link hover:bg-surface-2 flex items-center gap-1">
            <ArrowUp size={12} /> {t("files.up")}
          </button>
        )}

        {loading ? (
          <div className="text-sm text-muted py-8 text-center">{t("common.loading")}</div>
        ) : entries.length === 0 ? (
          <div className="text-center py-16">
            <FolderOpen size={40} className="mx-auto text-muted/30 mb-3" />
            <p className="text-sm text-muted">{t("files.empty")}</p>
          </div>
        ) : (
          <div className="rounded-card border border-border bg-surface overflow-hidden">
            {entries.map((e) => (
              <div key={e.path} onContextMenu={(ev) => handleContextMenu(ev, e)}
                className="group flex items-center gap-3 px-4 py-2.5 border-b border-faint last:border-b-0 hover:bg-surface-2 cursor-pointer text-sm">
                <button onClick={() => handleClick(e)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                  {e.isDir ? <FolderOpen size={16} className="text-accent/60 shrink-0" /> : <File size={16} className="text-muted shrink-0" />}
                  <span className="truncate text-text">{e.name}</span>
                  <span className="text-xs text-muted shrink-0 ml-auto">{e.isDir ? "—" : workspaceFiles.formatSize(e.size)}</span>
                </button>
                <button onClick={(ev) => { ev.stopPropagation(); handleDelete(e); }}
                  className="shrink-0 rounded p-1 text-muted hover:text-error hover:bg-error/10 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Trash2 size={14} /><span className="sr-only">{t("common.delete")}</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && <FileContextMenu entry={contextMenu.entry} point={contextMenu.point} onClose={() => setContextMenu(null)} onReference={() => referenceEntry(contextMenu.entry)} onCopy={(text) => void copyPath(text)} onDelete={() => void handleDelete(contextMenu.entry)} />}
    </WorkspacePage>
  );
}
