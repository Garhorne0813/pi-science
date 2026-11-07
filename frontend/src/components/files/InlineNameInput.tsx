import { useRef } from "react";
import { File, Folder } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Icon } from "../ui/Icon";
import type { InlineEditDraft } from "../../lib/workspace/inline-file-edit";

/** The one name input both file surfaces render. It owns no state: the surface
 *  keeps the draft, so a commit, a cancel, and a duplicate-name error stay in
 *  one place per surface instead of two copies of the keyboard handling. */
export function InlineNameInput({ draft, indent, onValueChange, onCommit, onCancel }: {
  draft: InlineEditDraft;
  /** Tree depth the input renders at; the row spacing matches the entry rows. */
  indent: number;
  onValueChange: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const selectedRef = useRef(false);
  const renaming = draft.edit.mode === "rename";
  const isFolder = draft.edit.kind === "dir";
  const label = renaming ? t("files.rename") : t(isFolder ? "files.newFolderName" : "files.newFileName");
  const errorText = draft.error === "conflict" ? t("files.nameExists")
    : draft.error === "invalid" ? t("files.nameInvalid")
    : draft.error === "request" ? t(renaming ? "files.renameError" : isFolder ? "files.folderCreateError" : "files.fileCreateError")
    : "";
  return (
    <div className="flex flex-col gap-0.5" style={{ paddingLeft: `${8 + indent * 12}px` }}>
      <div className="flex items-center gap-2">
        <Icon icon={isFolder ? Folder : File} size="xs" className="shrink-0 text-muted" />
        <input
          autoFocus
          value={draft.value}
          disabled={draft.saving}
          placeholder={label}
          aria-label={label}
          aria-invalid={draft.error !== null}
          onChange={(event) => onValueChange(event.target.value)}
          onFocus={(event) => {
            // Renaming preselects the stem so typing replaces the name but keeps
            // the extension. Selection happens once; a later click places the caret.
            if (!renaming || selectedRef.current) return;
            selectedRef.current = true;
            const { value } = event.currentTarget;
            const dot = value.lastIndexOf(".");
            event.currentTarget.setSelectionRange(0, dot > 0 ? dot : value.length);
          }}
          onKeyDown={(event) => {
            // Enter during IME composition accepts a candidate, not the name.
            if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); onCommit(); }
            if (event.key === "Escape") { event.preventDefault(); onCancel(); }
          }}
          onBlur={onCommit}
          className="h-tool w-full min-w-0 rounded-input border border-border bg-surface px-2 text-ui-body text-text outline-none focus:border-accent disabled:opacity-60"
        />
      </div>
      {errorText && <p role="alert" className="pl-1 text-ui-micro text-error-text">{errorText}</p>}
    </div>
  );
}
