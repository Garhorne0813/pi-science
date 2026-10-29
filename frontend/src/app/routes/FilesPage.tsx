import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderOpen, File, ChevronRight, Trash2, ArrowUp, FilePlus, FolderPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { copyTextToClipboard, useUiStore } from "../../lib/ui";
import { fileInspectorForPath } from "../../lib/artifacts";
import { absoluteWorkspacePath } from "../../lib/files/workspace-path";
import { workspaceFiles, type Breadcrumb } from "../../lib/workspace";
import { baseName, createDraft, editErrorFor, planCommit, projectEditRows, renameDraft, type FileKind, type InlineEditDraft } from "../../lib/workspace/inline-file-edit";
import { FileContextMenu, type ContextPoint, type FileListEntry } from "../../components/sidebar/FileContextMenu";
import { InlineNameInput } from "../../components/files/InlineNameInput";
import { refreshInspectorAfterRename } from "../../components/files/refresh-inspector-after-rename";
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
  const [loading, setLoading] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ entry: FileListEntry; point: ContextPoint } | null>(null);
  const [draft, setDraft] = useState<InlineEditDraft | null>(null);
  // Synchronous mirror of `draft` so a commit reads the value the input shows,
  // even when the keystroke and the Enter land in the same React batch.
  const draftRef = useRef<InlineEditDraft | null>(null);
  const updateDraft = (next: InlineEditDraft | null) => { draftRef.current = next; setDraft(next); };
  // Guards the polling fallback: a refresh for a previous subdir must never
  // overwrite entries for the current one (mirrors FileBrowser's token guard).
  const pollTokenRef = useRef(0);
  const openInspector = useUiStore((s) => s.openInspector);
  const addWorkspaceReference = useUiStore((s) => s.addWorkspaceReference);
  const fileRevision = useRuntimeStore((s) => s.fileRevision);
  const visibleEntries = notebookOnly ? entries.filter((entry) => entry.isDir || entry.name.toLowerCase().endsWith(".ipynb")) : entries;

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
          setEntries(result.entries);
          setBreadcrumbs(result.breadcrumbs);
        })
        .catch(() => undefined);
    }, 2_000);
    return () => { pollTokenRef.current += 1; window.clearInterval(id); };
  }, [workspaceCwd, subdir]);

  const refreshFiles = () => {
    workspaceFiles.invalidate();
    void loadFiles(subdir);
  };

  // The draft captures the directory it creates in, so leaving that directory
  // must close it: a committed draft would land in the wrong place.
  const navigate = (dir: string) => { updateDraft(null); setSubdir(dir); };

  const startCreate = (kind: FileKind, entry: FileListEntry | null) => {
    setContextMenu(null);
    const dir = entry?.isDir ? entry.path : subdir;
    if (entry?.isDir) setSubdir(entry.path);
    updateDraft(createDraft(kind, dir, null));
  };

  const startRename = (entry: FileListEntry) => { setContextMenu(null); updateDraft(renameDraft(entry)); };

  const cancelDraft = () => updateDraft(null);

  const commitDraft = async () => {
    const current = draftRef.current;
    if (!current || current.saving) return;
    const plan = planCommit(current);
    if (plan.kind === "cancel" || plan.kind === "unchanged") { updateDraft(null); return; }
    if (plan.kind === "invalid") { updateDraft({ ...current, error: "invalid" }); return; }
    const { mutation } = plan;
    updateDraft({ ...current, saving: true, error: null });
    try {
      if (mutation.kind === "create-file") await workspaceFiles.createFile(workspaceCwd, mutation.target);
      else if (mutation.kind === "create-folder") await workspaceFiles.mkdir(workspaceCwd, mutation.target, { exclusive: true });
      else await workspaceFiles.rename(workspaceCwd, mutation.source, mutation.target);
      updateDraft(null);
      if (mutation.kind === "rename") refreshInspectorAfterRename(mutation.source, mutation.target, workspaceCwd);
      await loadFiles(subdir);
      if (mutation.kind === "create-file") {
        toast(t("files.fileCreated", { name: baseName(mutation.target) }), "success");
        openInspector(fileInspectorForPath(mutation.target, baseName(mutation.target), undefined, workspaceCwd));
      } else if (mutation.kind === "create-folder") toast(t("files.folderCreated", { name: mutation.target }), "success");
      else toast(t("files.renamed", { name: baseName(mutation.target) }), "success");
    } catch (error) {
      const errorKind = editErrorFor(error);
      // A conflict leaves the input open so the name can be corrected in place.
      if (draftRef.current) updateDraft({ ...draftRef.current, saving: false, error: errorKind });
      if (errorKind === "request") toast(error instanceof Error ? error.message : t(mutation.kind === "rename" ? "files.renameError" : mutation.kind === "create-folder" ? "files.folderCreateError" : "files.fileCreateError"), "error");
    }
  };

  const handleClick = (entry: FileListEntry) => {
    if (entry.isDir) {
      navigate(entry.path);
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

  const revealEntry = async (entry: FileListEntry) => {
    setContextMenu(null);
    try {
      await workspaceFiles.reveal(workspaceCwd, entry.path);
    } catch (error) {
      toast(error instanceof Error ? error.message : t("files.revealError"), "error");
    }
  };

  const rows = useMemo(() => projectEditRows(visibleEntries.map((entry) => ({ ...entry, depth: 0 })), draft), [visibleEntries, draft]);

  return (
    <WorkspacePage>
      <WorkspacePageHeader
        title={t("nav.files")}
        description={
          <div className="flex flex-wrap items-center gap-1">
              <button onClick={() => navigate("")} className="hover:text-text">{t("files.workspace")}</button>
              {breadcrumbs.map((bc) => (
                <span key={bc.path} className="flex items-center gap-1">
                  <ChevronRight size={12} />
                  <button onClick={() => navigate(bc.path)} className="hover:text-text">{bc.name}</button>
                </span>
              ))}
          </div>
        }
        actions={
          <>
            <button type="button" onClick={() => startCreate("file", null)} aria-label={t("files.newFile")} title={t("files.newFile")}
              className="flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text">
              <FilePlus size={14} />
            </button>
            <button type="button" onClick={() => startCreate("dir", null)} aria-label={t("files.newFolder")} title={t("files.newFolder")}
              className="flex min-h-9 min-w-9 shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-2 hover:text-text">
              <FolderPlus size={14} />
            </button>
            <WorkspacePageRefreshButton label={t("common.refresh")} loading={loading} onClick={refreshFiles} />
          </>
        }
      />

      <div className="mt-6">
        {/* Subdirectory navigation */}
        {subdir && (
          <button onClick={() => { const parts = subdir.split("/"); parts.pop(); navigate(parts.join("/")); }}
            className="mb-3 rounded-input px-2 py-1 text-xs text-link hover:bg-surface-2 flex items-center gap-1">
            <ArrowUp size={12} /> {t("files.up")}
          </button>
        )}

        {rows.length === 0 ? (
          loading ? (
            <div className="text-sm text-muted py-8 text-center">{t("common.loading")}</div>
          ) : (
            <div className="text-center py-16">
              <FolderOpen size={40} className="mx-auto text-muted/30 mb-3" />
              <p className="text-sm text-muted">{t("files.empty")}</p>
            </div>
          )
        ) : (
          <div className="ui-card-flat overflow-hidden rounded-card">
            {rows.map((item) => item.kind === "editor" ? (
              draft && (
                <div key="inline-editor" className="px-4 py-2.5 border-b border-faint last:border-b-0">
                  <InlineNameInput key="inline-editor" draft={draft} indent={item.indent} onValueChange={(value) => updateDraft({ ...draft, value, error: null })} onCommit={() => void commitDraft()} onCancel={cancelDraft} />
                </div>
              )
            ) : (
              <div key={item.row.path} onContextMenu={(ev) => handleContextMenu(ev, item.row)}
                className="group flex items-center gap-3 px-4 py-2.5 border-b border-faint last:border-b-0 hover:bg-surface-2 cursor-pointer text-sm">
                <button onClick={() => handleClick(item.row)} className="flex items-center gap-3 flex-1 min-w-0 text-left">
                  {item.row.isDir ? <FolderOpen size={16} className="text-accent/60 shrink-0" /> : <File size={16} className="text-muted shrink-0" />}
                  <span className="truncate text-text">{item.row.name}</span>
                  <span className="text-xs text-muted shrink-0 ml-auto">{item.row.isDir ? "—" : workspaceFiles.formatSize(item.row.size)}</span>
                </button>
                <button onClick={(ev) => { ev.stopPropagation(); handleDelete(item.row); }}
                  className="shrink-0 rounded p-1 text-muted hover:text-error-text hover:bg-error/10 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Trash2 size={14} /><span className="sr-only">{t("common.delete")}</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && <FileContextMenu entry={contextMenu.entry} point={contextMenu.point} onClose={() => setContextMenu(null)} onReference={() => referenceEntry(contextMenu.entry)} onCopy={(text) => void copyPath(text)} onCopyAbsolutePath={() => void copyPath(absoluteWorkspacePath(workspaceCwd, contextMenu.entry.path))} onReveal={() => void revealEntry(contextMenu.entry)} onCreateFile={() => startCreate("file", contextMenu.entry)} onCreateFolder={() => startCreate("dir", contextMenu.entry)} onRename={() => startRename(contextMenu.entry)} onDelete={() => void handleDelete(contextMenu.entry)} />}
    </WorkspacePage>
  );
}
