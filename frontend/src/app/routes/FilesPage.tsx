import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { FolderOpen, File, ChevronRight, RefreshCw, Trash2, ArrowUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "../../lib/store";
import { fileInspectorForPath } from "../../lib/artifacts";
import { apiRequest, invalidateApiCache } from "../../lib/api";
import { FileContextMenu, type ContextPoint, type FileListEntry } from "../../components/sidebar/FileContextMenu";
import { useFeedback } from "../../components/feedback/feedback-context";

interface Breadcrumb {
  name: string; path: string;
}

export function FilesPage() {
  const { t } = useTranslation();
  const { confirm, toast } = useFeedback();
  const { cwd: rawCwd } = useParams<{ cwd: string }>();
  const workspaceCwd = rawCwd ? decodeURIComponent(rawCwd) : ".";
  const [entries, setEntries] = useState<FileListEntry[]>([]);
  const [breadcrumbs, setBreadcrumbs] = useState<Breadcrumb[]>([]);
  const [subdir, setSubdir] = useState("");
  const [loading, setLoading] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ entry: FileListEntry; point: ContextPoint } | null>(null);
  const openInspector = useUiStore((s) => s.openInspector);
  const addWorkspaceReference = useUiStore((s) => s.addWorkspaceReference);

  const loadFiles = useCallback(async (dir: string, signal?: AbortSignal) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ cwd: workspaceCwd });
      if (dir) params.set("subdir", dir);
      const [files, nextBreadcrumbs] = await Promise.all([
        apiRequest<FileListEntry[]>(`/api/files?${params}`, { signal, cacheTtlMs: 3000 }),
        apiRequest<Breadcrumb[]>(`/api/files/breadcrumbs?cwd=${encodeURIComponent(workspaceCwd)}&subdir=${encodeURIComponent(dir)}`, { signal, cacheTtlMs: 3000 }),
      ]);
      setEntries(files);
      setBreadcrumbs(nextBreadcrumbs);
    } catch (error) {
      if (!signal?.aborted) toast(error instanceof Error ? error.message : t("files.loadError"), "error");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [workspaceCwd, t, toast]);

  useEffect(() => {
    const controller = new AbortController();
    void loadFiles(subdir, controller.signal);
    return () => controller.abort();
  }, [loadFiles, subdir]);

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
      await apiRequest(`/api/files/${encodeURIComponent(entry.path)}?cwd=${encodeURIComponent(workspaceCwd)}`, { method: "DELETE" });
      invalidateApiCache("/api/files");
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
            <h1 className="font-serif text-xl text-text">{t("nav.files")}</h1>
            {/* Breadcrumbs */}
            <div className="flex items-center gap-1 mt-2 text-sm text-muted">
              <button onClick={() => setSubdir("")} className="hover:text-text">{t("files.workspace")}</button>
              {breadcrumbs.map((bc) => (
                <span key={bc.path} className="flex items-center gap-1">
                  <ChevronRight size={12} />
                  <button onClick={() => setSubdir(bc.path)} className="hover:text-text">{bc.name}</button>
                </span>
              ))}
            </div>
          </div>
          <button onClick={() => void loadFiles(subdir)} className="rounded-input px-2 py-1 text-xs text-muted hover:text-text hover:bg-surface-2 flex items-center gap-1">
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> {t("common.refresh")}
          </button>
        </div>

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
                  <span className="text-xs text-muted shrink-0 ml-auto">{e.isDir ? "—" : humanSize(e.size)}</span>
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
    </div>
  );
}
