import { useCallback, useEffect, useState } from "react";
import { FolderOpen, File, ChevronRight, ChevronDown, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUiStore } from "../../lib/store";
import { fileInspectorForPath } from "../../lib/artifacts";
import { apiRequest, invalidateApiCache } from "../../lib/api";
import { useFeedback } from "../feedback/feedback-context";
import { FileContextMenu, type ContextPoint, type FileListEntry } from "./FileContextMenu";

export function FileBrowser({ cwd }: { cwd: string }) {
  const { t } = useTranslation();
  const { confirm, toast } = useFeedback();
  const [entries, setEntries] = useState<FileListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ entry: FileListEntry; point: ContextPoint } | null>(null);
  const openInspector = useUiStore((s) => s.openInspector);
  const addWorkspaceReference = useUiStore((s) => s.addWorkspaceReference);

  const loadFiles = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ cwd });
      const data = await apiRequest<FileListEntry[]>(`/api/files?${params}`, { signal, cacheTtlMs: 3000 });
      setEntries(Array.isArray(data) ? data.filter((entry) => !entry.name.startsWith(".")).slice(0, 30) : []);
    } catch (error) {
      if (!signal?.aborted) toast(error instanceof Error ? error.message : t("files.loadError"), "error");
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [cwd, t, toast]);

  useEffect(() => {
    const controller = new AbortController();
    void loadFiles(controller.signal);
    return () => controller.abort();
  }, [loadFiles]);

  const handleClick = (entry: FileListEntry) => {
    if (entry.isDir) return;
    openInspector(fileInspectorForPath(entry.path, entry.name, undefined, cwd));
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
      await apiRequest(`/api/files/${encodeURIComponent(entry.path)}?cwd=${encodeURIComponent(cwd)}`, { method: "DELETE" });
      invalidateApiCache("/api/files");
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
        <span onClick={(e) => { e.stopPropagation(); void loadFiles(); }} className="hover:text-text cursor-pointer">
          <RefreshCw size={10} className={loading ? "animate-spin" : ""} />
        </span>
      </div>
      {expanded && (
        <div className="mt-1 flex flex-col gap-0.5 max-h-48 overflow-y-auto">
          {loading && entries.length === 0 ? (
            <p className="px-2 text-[11px] text-muted/60 italic">{t("common.loading")}</p>
          ) : entries.length === 0 ? (
            <p className="px-2 text-[11px] text-muted/60 italic">{t("files.empty")}</p>
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
      {contextMenu && <FileContextMenu entry={contextMenu.entry} point={contextMenu.point} onClose={() => setContextMenu(null)} onReference={() => referenceEntry(contextMenu.entry)} onCopy={(text) => void copyToClipboard(text)} onDelete={() => void deleteEntry(contextMenu.entry)} />}
    </div>
  );
}
