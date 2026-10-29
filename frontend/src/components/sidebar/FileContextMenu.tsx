import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Copy, ExternalLink, FilePlus, FolderPlus, Link2, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface FileListEntry {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export interface ContextPoint { x: number; y: number }

export function FileContextMenu({ entry, point, onClose, onReference, onCopy, onCopyAbsolutePath, onReveal, onCreateFile, onCreateFolder, onRename, onDelete }: {
  entry: FileListEntry;
  point: ContextPoint;
  onClose: () => void;
  onReference: () => void;
  onCopy: (text: string) => void;
  /** Copy the absolute path instead of the workspace-relative one. Omitted by
   *  callers that have no workspace cwd to resolve against. */
  onCopyAbsolutePath?: () => void;
  /** Open the entry in the OS file manager. Omitted by callers without a cwd. */
  onReveal?: () => void;
  /** Inline-create a file beside this entry. Omitted where creation is unavailable. */
  onCreateFile?: () => void;
  /** Inline-create a folder beside this entry. Omitted where creation is unavailable. */
  onCreateFolder?: () => void;
  /** Inline-rename this entry. Omitted where the row cannot be renamed. */
  onRename?: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [direction, setDirection] = useState({ left: false, up: false });

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    setDirection({ left: point.x + rect.width > window.innerWidth - 8, up: point.y + rect.height > window.innerHeight - 8 });
  }, [point.x, point.y]);

  useEffect(() => {
    const close = () => onClose();
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("click", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
      document.removeEventListener("keydown", keydown);
    };
  }, [onClose]);

  return (
    <div ref={ref} role="menu" className="ui-popover fixed z-50 w-[180px] max-w-[calc(100vw-16px)] rounded-card p-1" style={{ left: point.x, top: point.y, transform: `translate(${direction.left ? "-100%" : "0"}, ${direction.up ? "-100%" : "0"})` }} onClick={(event) => event.stopPropagation()}>
      {onCreateFile && <MenuButton icon={<FilePlus size={12} />} label={t("files.newFile")} onClick={onCreateFile} />}
      {onCreateFolder && <MenuButton icon={<FolderPlus size={12} />} label={t("files.newFolder")} onClick={onCreateFolder} />}
      <MenuDivider />
      <MenuButton icon={<Link2 size={12} />} label={entry.isDir ? t("files.referenceFolder") : t("files.referenceFile")} onClick={onReference} />
      <MenuButton icon={<Copy size={12} />} label={t("files.copyPath")} onClick={() => onCopy(entry.path)} />
      {onCopyAbsolutePath && <MenuButton icon={<Copy size={12} />} label={t("files.copyAbsolutePath")} onClick={onCopyAbsolutePath} />}
      <MenuButton icon={<Copy size={12} />} label={t("files.copyName")} onClick={() => onCopy(entry.name)} />
      {onReveal && <MenuButton icon={<ExternalLink size={12} />} label={t("files.revealInFileManager")} onClick={onReveal} />}
      <MenuDivider />
      {onRename && <MenuButton icon={<Pencil size={12} />} label={t("files.rename")} onClick={onRename} />}
      <MenuButton danger icon={<Trash2 size={12} />} label={t("common.delete")} onClick={onDelete} />
    </div>
  );
}

function MenuDivider() {
  return <div role="separator" className="my-1 h-px bg-faint" />;
}

function MenuButton({ icon, label, onClick, danger = false }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" role="menuitem" onClick={onClick} className={`flex w-full items-center gap-2 rounded-input px-3 py-1.5 text-left text-[12px] ${danger ? "text-error-text hover:bg-error/10" : "text-text hover:bg-surface-hover"}`}><span className={danger ? "" : "text-muted"}>{icon}</span>{label}</button>;
}
