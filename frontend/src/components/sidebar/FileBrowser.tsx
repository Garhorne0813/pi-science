import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, FolderOpen, File, FileSpreadsheet, FileText, Image, BookOpen, ChevronRight, ChevronDown, RefreshCw, FolderPlus, FilePlus, Loader2, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn, copyTextToClipboard, useUiStore } from "../../lib/ui";
import { pinnedFileInspector } from "../../lib/artifacts";
import { absoluteWorkspacePath } from "../../lib/files/workspace-path";
import { SIDEBAR_FILE_LIMIT, sortFileEntries, workspaceFiles } from "../../lib/workspace";
import { baseName, createDraft, editErrorFor, parentDir, planCommit, projectEditRows, renameDraft, type FileKind, type InlineEditDraft } from "../../lib/workspace/inline-file-edit";
import { useFeedback } from "../feedback/feedback-context";
import { InlineNameInput } from "../files/InlineNameInput";
import { refreshInspectorAfterRename } from "../files/refresh-inspector-after-rename";
import { FileContextMenu, type ContextPoint, type FileListEntry } from "./FileContextMenu";
import { useRuntimeStore } from "../../lib/agent-runtime";
import { Icon } from "../ui/Icon";
import { ApiError, apiRequest } from "../../lib/client/api";

interface DirState { entries: FileListEntry[]; loading: boolean; error: string | null }

// A compact icon vocabulary for common research output formats.
function iconForFile(name: string): LucideIcon {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  if ([".csv", ".tsv", ".xlsx"].includes(ext)) return FileSpreadsheet;
  if ([".md", ".txt", ".pdf"].includes(ext)) return FileText;
  if (ext === ".ipynb") return BookOpen;
  if ([".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(ext)) return Image;
  return File;
}

const FILE_BROWSER_MIN_HEIGHT = 112;
const FILE_BROWSER_MAX_HEIGHT = 560;
const SIDEBAR_FIXED_CONTENT_HEIGHT = 240;

function clampFileBrowserHeight(height: number, containerHeight?: number) {
  const availableHeight = containerHeight
    ? Math.max(FILE_BROWSER_MIN_HEIGHT, containerHeight - SIDEBAR_FIXED_CONTENT_HEIGHT)
    : FILE_BROWSER_MAX_HEIGHT;
  return Math.min(FILE_BROWSER_MAX_HEIGHT, availableHeight, Math.max(FILE_BROWSER_MIN_HEIGHT, height));
}

export function FileBrowser({ cwd, embedded = false, active = true }: { cwd: string; embedded?: boolean; active?: boolean }) {
  const { t } = useTranslation();
  const { confirm, toast } = useFeedback();
  const [entries, setEntries] = useState<FileListEntry[]>([]);
  // One inline name editor at a time, so no combination of state can render two inputs.
  const [draft, setDraft] = useState<InlineEditDraft | null>(null);
  // Mirrored synchronously: Escape must beat the unmount blur, and Enter plus
  // blur must not submit the same draft twice.
  const draftRef = useRef<InlineEditDraft | null>(null);
  const updateDraft = (next: InlineEditDraft | null) => { draftRef.current = next; setDraft(next); };
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const visible = embedded || expanded;
  const shouldPoll = active && visible;
  const [contextMenu, setContextMenu] = useState<{ entry: FileListEntry; point: ContextPoint } | null>(null);
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());
  const [folderStates, setFolderStates] = useState<Map<string, DirState>>(new Map());
  const openFoldersRef = useRef<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const resizeStartRef = useRef<{ pointerId: number; y: number; height: number } | null>(null);
  // Guards async results: any newer load/toggle invalidates older in-flight
  // requests (workspace switch, rapid toggles, revision bumps).
  const requestTokenRef = useRef(0);
  // Quiet polling participates in result freshness, but must not take ownership
  // of the foreground loading indicator. Otherwise a poll that supersedes a
  // visible request can leave the refresh icon spinning forever.
  const visibleLoadTokenRef = useRef<number | null>(null);
  // The `work/` folder auto-opens only once per workspace, so a later revision
  // refresh does not fight a user who deliberately closed it.
  const initializedRef = useRef(false);
  const openInspector = useUiStore((s) => s.openInspector);
  const addWorkspaceReference = useUiStore((s) => s.addWorkspaceReference);
  const fileBrowserHeight = useUiStore((s) => s.sidebarFileBrowserHeight);
  const setFileBrowserHeight = useUiStore((s) => s.setSidebarFileBrowserHeight);
  const fileRevision = useRuntimeStore((s) => s.fileRevision);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const [resizing, setResizing] = useState(false);

  const [dropTarget, setDropTarget] = useState<{ path: string; valid: boolean } | null>(null);
  const [uploadStatus, setUploadStatus] = useState("");
  const [uploading, setUploading] = useState(false);
  const uploadRef = useRef<AbortController | null>(null);
  const recentRootPathsRef = useRef<string[]>([]);

  useEffect(() => {
    setDropTarget(null);
    setUploadStatus("");
    setUploading(false);
    recentRootPathsRef.current = [];
    return () => {
      uploadRef.current?.abort();
      uploadRef.current = null;
    };
  }, [cwd]);

  useEffect(() => {
    const clear = () => setDropTarget(null);
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") clear(); };
    window.addEventListener("dragend", clear);
    window.addEventListener("drop", clear);
    window.addEventListener("blur", clear);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("dragend", clear);
      window.removeEventListener("drop", clear);
      window.removeEventListener("blur", clear);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => { if (!shouldPoll) setDropTarget(null); }, [shouldPoll]);

  const availableContainerHeight = () => rootRef.current?.parentElement?.getBoundingClientRect().height;
  const displayedHeight = clampFileBrowserHeight(dragHeight ?? fileBrowserHeight);

  useEffect(() => {
    if (!resizing) return;
    const handlePointerMove = (event: PointerEvent) => {
      const start = resizeStartRef.current;
      if (!start || event.pointerId !== start.pointerId) return;
      setDragHeight(clampFileBrowserHeight(start.height + start.y - event.clientY, availableContainerHeight()));
    };
    const finishResize = (event: PointerEvent) => {
      const start = resizeStartRef.current;
      if (!start || event.pointerId !== start.pointerId) return;
      const height = clampFileBrowserHeight(start.height + start.y - event.clientY, availableContainerHeight());
      setFileBrowserHeight(height);
      resizeStartRef.current = null;
      setDragHeight(null);
      setResizing(false);
    };
    const cancelResize = (event: PointerEvent) => {
      const start = resizeStartRef.current;
      if (!start || event.pointerId !== start.pointerId) return;
      resizeStartRef.current = null;
      setDragHeight(null);
      setResizing(false);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", cancelResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", cancelResize);
    };
  }, [resizing, setFileBrowserHeight]);

  const loadFiles = useCallback(async (signal?: AbortSignal, quiet = false) => {
    const token = ++requestTokenRef.current;
    if (!quiet) {
      visibleLoadTokenRef.current = token;
      setLoading(true);
    }
    try {
      const rootEntries = await workspaceFiles.sidebar(cwd, signal, recentRootPathsRef.current);
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
    } finally {
      if (!quiet && token === visibleLoadTokenRef.current) {
        visibleLoadTokenRef.current = null;
        setLoading(false);
      }
    }
  }, [cwd, t, toast]);

  // Reset per-workspace state when the cwd changes.
  useEffect(() => {
    initializedRef.current = false;
    requestTokenRef.current += 1;
    openFoldersRef.current = new Set();
    setOpenFolders(new Set());
    setFolderStates(new Map());
    updateDraft(null);
  }, [cwd]);

  useEffect(() => {
    if (!shouldPoll) return;
    const controller = new AbortController();
    void loadFiles(controller.signal);
    return () => controller.abort();
  }, [shouldPoll, fileRevision, loadFiles]);

  // Polling fallback while the browser tab is visible: catches files created
  // by kernels or external tools that never emitted a terminal event. Quiet so
  // repeated refreshes never flash the loading indicator.
  useEffect(() => {
    if (!shouldPoll) return;
    const id = window.setInterval(() => void loadFiles(undefined, true), 2_000);
    return () => window.clearInterval(id);
  }, [shouldPoll, loadFiles]);

  const handleClick = (entry: FileListEntry) => {
    if (entry.isDir) {
      toggleFolder(entry.path);
      return;
    }
    // File-tree clicks resolve the newest published version first so the
    // inspector shows the version badge and diff controls for artifacts.
    void pinnedFileInspector(entry.path, entry.name, undefined, cwd).then((inspector) => openInspector(inspector));
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
      // Directories first in each level; sorting the flattened result would break nesting.
      for (const entry of sortFileEntries(items)) {
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

  const rows = useMemo(() => projectEditRows(folderEntries, draft), [folderEntries, draft]);

  const refreshFiles = () => {
    workspaceFiles.invalidate();
    void loadFiles();
  };

  const uploadToDirectory = async (files: File[], directory: string, rejected: string[]) => {
    const controller = new AbortController();
    uploadRef.current = controller;
    setUploading(true);
    const failures = [...rejected];
    const succeeded: string[] = [];
    try {
      for (const [index, file] of files.entries()) {
        if (controller.signal.aborted) break;
        setUploadStatus(t("files.uploadProgress", { current: index + 1, total: files.length, name: file.name }));
        try {
          // File.name should be a basename; never let a synthetic drop supply a path.
          if (!file.name || /[/\\]/.test(file.name) || file.name === "." || file.name === "..") {
            throw new Error(t("files.uploadInvalidName"));
          }
          const form = new FormData();
          form.append("file", file);
          await apiRequest(`/api/files/upload?${new URLSearchParams({ cwd, path: directory ? `${directory}/${file.name}` : file.name })}`, {
            method: "POST", body: form, signal: controller.signal,
            errorFallback: t("files.uploadError"),
          });
          succeeded.push(file.name);
        } catch (error) {
          if (controller.signal.aborted) break;
          const reason = error instanceof ApiError && error.status === 409 ? t("files.uploadConflict")
            : error instanceof ApiError && error.status === 413 ? t("files.uploadTooLarge")
            : error instanceof Error ? error.message : t("files.uploadError");
          failures.push(`${file.name}: ${reason}`);
        }
      }
      // A batch refresh must not hold up the next upload or multiply queries by
      // the number of files. Invalidate even if the workspace changed mid-batch.
      if (succeeded.length) workspaceFiles.invalidate();
      if (controller.signal.aborted) return;
      if (succeeded.length) {
        if (directory) {
          openFoldersRef.current = new Set([...openFoldersRef.current, directory]);
          setOpenFolders(new Set(openFoldersRef.current));
        } else {
          const uploaded = new Set(succeeded);
          recentRootPathsRef.current = [
            ...recentRootPathsRef.current.filter((path) => !uploaded.has(path)), ...uploaded,
          ].slice(-SIDEBAR_FILE_LIMIT);
        }
        await loadFiles(controller.signal, true);
      }
      if (controller.signal.aborted) return;
      const summary = t("files.uploadResult", { succeeded: succeeded.length, failed: failures.length });
      const message = failures.length ? `${summary} ${failures.join("; ")}` : summary;
      setUploadStatus(message);
      toast(message, failures.length ? "error" : "success");
    } finally {
      if (uploadRef.current === controller) {
        uploadRef.current = null;
        setUploading(false);
        setDropTarget(null);
      }
    }
  };

  // Delegate to rows so nested icons/text never change the target or flicker.
  // Only OS file drags are intercepted; text/links and internal drags pass through.
  const handleFileDrag = (event: React.DragEvent<HTMLDivElement>, drop = false) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    const row = (event.target as Element).closest<HTMLElement>("[data-file-drop-path]");
    const directory = row ? (row.dataset.fileDropDirectory === "true" ? row.dataset.fileDropPath! : null) : "";
    event.dataTransfer.dropEffect = directory === null || uploading || !active ? "none" : "copy";
    if (!drop) {
      setDropTarget(uploading || !active ? null : { path: directory ?? row!.dataset.fileDropPath!, valid: directory !== null });
      return;
    }
    setDropTarget(null);
    if (directory === null || uploadRef.current || !active) return;
    const rejected: string[] = [];
    const files: File[] = [];
    const items = Array.from(event.dataTransfer.items ?? []).filter((item) => item.kind === "file");
    if (items.length) {
      for (const item of items) {
        const entry = item.webkitGetAsEntry?.();
        if (entry?.isDirectory) rejected.push(`${entry.name}: ${t("files.uploadFolderUnsupported")}`);
        else {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
    } else files.push(...Array.from(event.dataTransfer.files));
    if (files.length || rejected.length) void uploadToDirectory(files, directory, rejected);
  };

  const rejectFileDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "none";
    setDropTarget(null);
  };

  const handleContextMenu = (e: React.MouseEvent, entry: FileListEntry) => {
    e.preventDefault();
    setContextMenu({ entry, point: { x: e.clientX, y: e.clientY } });
  };

  const copyToClipboard = async (text: string) => {
    // Close the menu before the clipboard round-trip. Closing it from the
    // continuation lets a slow (or permission-blocked) write unmount a menu the
    // user already reopened, which silently swallows the next click.
    setContextMenu(null);
    const copied = await copyTextToClipboard(text);
    toast(t(copied ? "files.copied" : "files.copyFailed"), copied ? "success" : "error");
  };

  const referenceEntry = (entry: FileListEntry) => {
    addWorkspaceReference({ cwd, path: entry.path, name: entry.name, isDir: entry.isDir });
    setContextMenu(null);
  };

  const startCreate = (kind: FileKind, entry: FileListEntry | null) => {
    setContextMenu(null);
    const dir = entry ? (entry.isDir ? entry.path : parentDir(entry.path)) : "";
    // A collapsed target hides its own first child, so open it before rendering the input.
    if (entry?.isDir && !openFoldersRef.current.has(entry.path)) void toggleFolder(entry.path);
    updateDraft(createDraft(kind, dir, entry?.path ?? null));
  };

  const startRename = (entry: FileListEntry) => {
    setContextMenu(null);
    updateDraft(renameDraft(entry));
  };

  const cancelDraft = () => updateDraft(null);

  // A renamed folder must not keep its old open key. Descendants are dropped
  // rather than remapped, so the renamed folder reads as a fresh collapsed entry.
  const forgetSubtree = (root: string) => {
    const within = (path: string) => path === root || path.startsWith(`${root}/`);
    openFoldersRef.current = new Set([...openFoldersRef.current].filter((path) => !within(path)));
    setOpenFolders(new Set(openFoldersRef.current));
    setFolderStates((prev) => new Map([...prev].filter(([path]) => !within(path))));
  };

  const commitDraft = async () => {
    const current = draftRef.current;
    if (!current || current.saving) return;
    const plan = planCommit(current);
    if (plan.kind === "cancel" || plan.kind === "unchanged") { updateDraft(null); return; }
    if (plan.kind === "invalid") { updateDraft({ ...current, error: "invalid" }); return; }
    const { mutation } = plan;
    updateDraft({ ...current, saving: true, error: null });
    try {
      if (mutation.kind === "create-file") await workspaceFiles.createFile(cwd, mutation.target);
      else if (mutation.kind === "create-folder") await workspaceFiles.mkdir(cwd, mutation.target, { exclusive: true });
      else await workspaceFiles.rename(cwd, mutation.source, mutation.target);
      updateDraft(null);
      if (mutation.kind === "rename") { forgetSubtree(mutation.source); refreshInspectorAfterRename(mutation.source, mutation.target, cwd); }
      // The root listing is capped, so pin the new path to keep it on screen.
      if (parentDir(mutation.target) === "") recentRootPathsRef.current = [...recentRootPathsRef.current.filter((path) => path !== mutation.target), mutation.target].slice(-SIDEBAR_FILE_LIMIT);
      await loadFiles();
      if (mutation.kind === "create-file") {
        toast(t("files.fileCreated", { name: baseName(mutation.target) }), "success");
        void pinnedFileInspector(mutation.target, baseName(mutation.target), undefined, cwd).then((inspector) => openInspector(inspector));
      } else if (mutation.kind === "create-folder") toast(t("files.folderCreated", { name: mutation.target }), "success");
      else toast(t("files.renamed", { name: baseName(mutation.target) }), "success");
    } catch (error) {
      const errorKind = editErrorFor(error);
      // A cancel during the request already cleared the draft; do not resurrect it.
      if (draftRef.current) updateDraft({ ...current, saving: false, error: errorKind });
      if (errorKind === "request") toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const revealEntry = async (entry: FileListEntry) => {
    setContextMenu(null);
    try {
      await workspaceFiles.reveal(cwd, entry.path);
    } catch (error) {
      toast(error instanceof Error ? error.message : t("files.revealError"), "error");
    }
  };

  const deleteEntry = async (entry: FileListEntry) => {
    setContextMenu(null);
    // Folder deletion removes the whole subtree; the confirmation names that.
    const approved = await confirm({ title: entry.isDir ? t("files.deleteFolderTitle") : t("files.deleteFileTitle"), message: entry.isDir ? t("files.deleteFolderConfirm", { name: entry.name }) : t("files.deleteConfirm", { name: entry.name }), confirmLabel: t("common.delete"), destructive: true });
    if (!approved) return;
    try {
      await workspaceFiles.remove(cwd, entry.path, { recursive: entry.isDir });
      await loadFiles();
      toast(t("files.deleted", { name: entry.name }), "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : t("files.deleteError"), "error");
    }
  };

  return (
    <div
      ref={rootRef}
      onDragEnter={rejectFileDrop}
      onDragOver={rejectFileDrop}
      onDrop={rejectFileDrop}
      className={cn("flex min-h-0 flex-col", embedded ? "h-full flex-1" : "mt-2 shrink-0")}
      style={!embedded && expanded ? { height: displayedHeight, maxHeight: "calc(100dvh - 240px)" } : undefined}
    >
      {!embedded && (expanded ? (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("files.resize")}
          aria-valuemin={FILE_BROWSER_MIN_HEIGHT}
          aria-valuemax={FILE_BROWSER_MAX_HEIGHT}
          aria-valuenow={displayedHeight}
          tabIndex={0}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            resizeStartRef.current = { pointerId: event.pointerId, y: event.clientY, height: displayedHeight };
            setResizing(true);
          }}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const delta = event.key === "ArrowUp" ? 16 : -16;
            setFileBrowserHeight(clampFileBrowserHeight(displayedHeight + delta, availableContainerHeight()));
          }}
          className="group relative h-2 shrink-0 cursor-row-resize touch-none"
        >
          <div className={`absolute inset-x-0 top-1/2 h-px -translate-y-1/2 transition-colors ${resizing ? "bg-accent/70" : "bg-faint group-hover:bg-accent/50"}`} />
        </div>
      ) : (
        <div className="h-px shrink-0 bg-faint" />
      ))}
      <div className="flex min-h-0 flex-1 flex-col pt-2">
        <div className="flex items-center">
          {embedded ? <span className="flex-1 px-2 text-ui-meta font-medium uppercase tracking-wide text-muted">{t("nav.files")}</span> : <button
            type="button"
            onClick={() => { setExpanded(!expanded); if (!expanded) void loadFiles(); }}
            className="flex h-tool min-w-0 flex-1 items-center gap-1.5 px-2 text-ui-caption font-medium uppercase tracking-wider text-muted hover:text-text"
          >
            <Icon icon={expanded ? ChevronDown : ChevronRight} size="xs" />
            <span className="truncate">{t("nav.files")}</span>
          </button>}
          <button
            type="button"
            aria-label={t("files.newFile")}
            title={t("files.newFile")}
            onClick={() => startCreate("file", null)}
            className="flex h-tool w-tool shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            <Icon icon={FilePlus} size="xs" />
          </button>
          <button
            type="button"
            aria-label={t("files.newFolder")}
            title={t("files.newFolder")}
            onClick={() => startCreate("dir", null)}
            className="flex h-tool w-tool shrink-0 items-center justify-center rounded-input text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            <Icon icon={FolderPlus} size="xs" />
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
        {visible && (
          <div
            aria-label={t("files.dropRoot")}
            aria-busy={uploading}
            onDragEnter={handleFileDrag}
            onDragOver={handleFileDrag}
            onDrop={(event) => handleFileDrag(event, true)}
            onDragLeave={(event) => {
              if (!Array.from(event.dataTransfer.types).includes("Files")) return;
              if (event.relatedTarget instanceof Node) {
                if (event.currentTarget.contains(event.relatedTarget)) return;
              } else if (!event.relatedTarget) {
                // Native file drags often omit relatedTarget. Coordinates describe
                // the actual boundary, regardless of how many children were crossed.
                const rect = event.currentTarget.getBoundingClientRect();
                if (event.clientX > rect.left && event.clientX < rect.right
                  && event.clientY > rect.top && event.clientY < rect.bottom) return;
              }
              setDropTarget(null);
            }}
            className={cn("mt-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto rounded-input", dropTarget?.path === "" && dropTarget.valid && "bg-accent/10 ring-2 ring-inset ring-accent/60")}
          >
            {!draft && folderEntries.length === 0 ? (
              <p className="px-2 text-ui-meta italic text-muted/60">{loading ? t("common.loading") : t("files.empty")}</p>
            ) : (
              rows.map((item) => {
                if (item.kind === "editor") return draft ? (
                  <InlineNameInput
                    key="inline-editor"
                    draft={draft}
                    indent={item.indent}
                    onValueChange={(value) => updateDraft({ ...draft, value, error: null })}
                    onCommit={() => void commitDraft()}
                    onCancel={cancelDraft}
                  />
                ) : null;
                const e = item.row;
                const state = folderStates.get(e.path);
                const isLoading = state?.loading;
                const error = state?.error;
                return (
                  <div key={e.path}>
                    <button
                      onClick={() => handleClick(e)}
                      onContextMenu={(ev) => handleContextMenu(ev, e)}
                      data-file-drop-path={e.path}
                      data-file-drop-directory={e.isDir}
                      data-drop-state={dropTarget?.path === e.path && dropTarget.valid ? "valid" : dropTarget?.path === e.path && !dropTarget.valid ? "invalid" : undefined}
                      className={cn("flex h-tool w-full items-center gap-2 truncate rounded-input px-2 text-left text-ui-caption text-text/80 transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40",
                        dropTarget?.path === e.path && dropTarget.valid && "bg-accent/10 ring-2 ring-inset ring-accent/60",
                        dropTarget?.path === e.path && !dropTarget.valid && "cursor-not-allowed bg-error/10 ring-2 ring-inset ring-error/60")}
                      title={e.path}
                      style={{ paddingLeft: `${8 + e.depth * 12}px` }}
                      aria-expanded={e.isDir ? openFolders.has(e.path) : undefined}
                    >
                      {e.isDir
                        ? <Icon icon={openFolders.has(e.path) ? ChevronDown : ChevronRight} size="xs" className="shrink-0 text-muted" />
                        : <span aria-hidden="true" className="w-3 shrink-0" />}
                      <Icon icon={e.isDir ? (openFolders.has(e.path) ? FolderOpen : Folder) : iconForFile(e.name)} size="sm" className="shrink-0 text-muted" />
                      <span className="truncate">{e.name}</span>
                      {isLoading && <Icon icon={Loader2} size="xs" className="ml-auto shrink-0 animate-spin text-muted" />}
                    </button>
                    {error && <p className="px-2 text-ui-micro italic text-error-text" style={{ paddingLeft: `${20 + e.depth * 12}px` }}>{error}</p>}
                  </div>
                );
              })
            )}
            <div className="min-h-10 flex-1 px-2 py-2 text-ui-meta text-muted/60">
              {t(dropTarget?.valid === false ? "files.dropInvalid" : "files.dropRoot")}
            </div>
          </div>
        )}
        {visible && uploadStatus && <p role="status" className="max-h-24 shrink-0 overflow-y-auto break-words px-2 py-1 text-ui-meta text-muted">{uploadStatus}</p>}
      </div>

      {/* Context menu */}
      {contextMenu && <FileContextMenu entry={contextMenu.entry} point={contextMenu.point} onClose={() => setContextMenu(null)} onReference={() => referenceEntry(contextMenu.entry)} onCopy={(text) => void copyToClipboard(text)} onCopyAbsolutePath={() => void copyToClipboard(absoluteWorkspacePath(cwd, contextMenu.entry.path))} onReveal={() => void revealEntry(contextMenu.entry)} onCreateFile={() => startCreate("file", contextMenu.entry)} onCreateFolder={() => startCreate("dir", contextMenu.entry)} onRename={() => startRename(contextMenu.entry)} onDelete={() => void deleteEntry(contextMenu.entry)} />}
    </div>
  );
}
