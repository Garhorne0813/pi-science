import { useEffect, useRef, useState } from "react";
import { Copy, Loader2, Upload, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { skillsMutations, type SkillUploadCandidate, type GithubSkillCandidate } from "../../lib/skills/skills-mutations";

function DialogShell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-black/40 p-4"
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="ui-dialog flex max-h-[86vh] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-large border border-border bg-surface-raised shadow-pop outline-none"
      >
        <header className="flex items-center justify-between gap-3 border-b border-faint px-5 py-3">
          <h2 className="text-ui-title font-medium tracking-tight text-text">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-full p-1.5 text-muted hover:bg-surface-2 hover:text-text">
            <X size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return <p role="alert" className="rounded-input bg-error/10 px-3 py-2 text-ui-caption text-error-text">{message}</p>;
}

const inputClass = "h-9 w-full rounded-input border border-border bg-surface-2 px-3 text-ui-label text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent/25";
const textareaClass = "w-full rounded-input border border-border bg-surface-2 px-3 py-2 text-ui-label text-text outline-none focus:border-accent focus:ring-1 focus:ring-accent/25";

export function SkillEditorDialog({
  open,
  cwd,
  initial,
  onClose,
}: {
  open: boolean;
  cwd: string;
  initial?: { name: string; description: string; body?: string } | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? "");
    setDescription(initial?.description ?? "");
    setBody(initial?.body ?? "");
    setError(null);
  }, [open, initial]);

  if (!open) return null;

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      if (initial?.name) {
        await skillsMutations.update(cwd, initial.name, { name, description, body });
      } else {
        await skillsMutations.create(cwd, { name, description, body });
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogShell title={initial?.name ? t("skills.editTitle") : t("skills.createTitle")} onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-ui-label text-muted">
          {t("skills.formName")}
          <input className={`${inputClass} mt-1`} value={name} disabled={Boolean(initial?.name)} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="block text-ui-label text-muted">
          {t("skills.formDescription")}
          <textarea className={`${textareaClass} mt-1 min-h-16 resize-y`} value={description} onChange={(event) => setDescription(event.target.value)} />
        </label>
        <label className="block text-ui-label text-muted">
          {t("skills.formBody")}
          <textarea className={`${textareaClass} mt-1 min-h-48 resize-y font-mono text-xs`} value={body} onChange={(event) => setBody(event.target.value)} placeholder="---" />
        </label>
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-input border border-border px-3 py-1.5 text-ui-caption text-muted hover:bg-surface-2" onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" disabled={saving || !name || !description} onClick={() => void submit()} className="flex min-h-9 items-center gap-1.5 rounded-input bg-accent px-3 text-ui-caption text-white disabled:opacity-50">
            {saving && <Loader2 size={12} className="animate-spin" />}
            {t("common.save")}
          </button>
        </div>
      </div>
    </DialogShell>
  );
}

export function SkillUploadDialog({ open, cwd, onClose }: { open: boolean; cwd: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [filename, setFilename] = useState("");
  const [contentBase64, setContentBase64] = useState("");
  const [candidates, setCandidates] = useState<SkillUploadCandidate[]>([]);
  const [selected, setSelected] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  const onFile = async (file: File) => {
    setError(null);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result ?? ""));
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(file);
    });
    const base64 = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
    setFilename(file.name);
    setContentBase64(base64);
    setBusy(true);
    try {
      const result = await skillsMutations.previewUpload(cwd, file.name, base64);
      const next = result.candidates ?? [];
      setCandidates(next);
      setSelected(next[0]?.root_path ?? "");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCandidates([]);
      setSelected("");
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await skillsMutations.importUpload(cwd, filename, contentBase64, selected);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell title={t("skills.uploadTitle")} onClose={onClose}>
      <div className="space-y-3">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="flex min-h-28 w-full flex-col items-center justify-center gap-2 rounded-card border border-dashed border-border bg-surface-2 px-4 py-6 text-sm text-muted hover:border-accent"
        >
          <Upload size={18} />
          {t("skills.uploadDrop")}
          <span className="text-ui-caption">{t("skills.uploadHint")}</span>
        </button>
        <input ref={inputRef} type="file" accept=".md,.zip,.skill" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onFile(file); }} />
        {busy && <p className="flex items-center gap-2 text-ui-caption text-muted"><Loader2 size={12} className="animate-spin" />{t("common.loading")}</p>}
        {candidates.length > 0 && (
          <div role="group" aria-label={t("skills.uploadSelect")} className="space-y-2">
            {candidates.map((candidate) => (
              <label key={candidate.root_path} className="flex items-center gap-2 rounded-input border border-border px-3 py-2">
                <input type="radio" name="skill-upload-root" checked={selected === candidate.root_path} onChange={() => setSelected(candidate.root_path)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text">{candidate.name}</span>
                  <span className="block truncate text-xs text-muted">{candidate.description || candidate.root_path}</span>
                  <span className="block text-[10px] text-muted">{candidate.files.length} files</span>
                </span>
              </label>
            ))}
          </div>
        )}
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-input border border-border px-3 py-1.5 text-ui-caption text-muted hover:bg-surface-2" onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" disabled={busy || !selected} onClick={() => void confirmImport()} className="flex min-h-9 items-center gap-1.5 rounded-input bg-accent px-3 text-ui-caption text-white disabled:opacity-50">
            {busy && <Loader2 size={12} className="animate-spin" />}
            {t("skills.uploadImport")}
          </button>
        </div>
      </div>
    </DialogShell>
  );
}

export function SkillGithubDialog({ open, cwd, onClose }: { open: boolean; cwd: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [repo, setRepo] = useState("");
  const [candidates, setCandidates] = useState<GithubSkillCandidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const preview = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await skillsMutations.previewGithub(repo);
      const next = result.candidates as GithubSkillCandidate[] ?? [];
      setCandidates(next);
      setSelected(next.map((candidate) => candidate.root_path));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setCandidates([]);
      setSelected([]);
    } finally {
      setBusy(false);
    }
  };

  const confirmImport = async () => {
    setBusy(true);
    setError(null);
    try {
      await skillsMutations.importGithub(cwd, repo, selected);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogShell title={t("skills.githubTitle")} onClose={onClose}>
      <div className="space-y-3">
        <label className="block text-ui-label text-muted">
          {t("skills.githubRepo")}
          <input className={`${inputClass} mt-1 font-mono`} value={repo} onChange={(event) => setRepo(event.target.value)} placeholder="owner/repo, owner/repo@ref, or https://github.com/..." />
        </label>
        <button type="button" disabled={busy || !repo.trim()} onClick={() => void preview()} className="flex min-h-9 items-center gap-1.5 rounded-input bg-accent px-3 text-ui-caption text-white disabled:opacity-50">
          {busy && <Loader2 size={12} className="animate-spin" />}
          {t("skills.githubPreview")}
        </button>
        {candidates.length > 0 && (
          <div role="group" aria-label={t("skills.uploadSelect")} className="space-y-2">
            {candidates.map((candidate) => (
              <label key={candidate.root_path} className="flex items-center gap-2 rounded-input border border-border px-3 py-2">
                <input type="checkbox" checked={selected.includes(candidate.root_path)} onChange={(event) => {
                  setSelected((current) => event.target.checked ? [...current, candidate.root_path] : current.filter((path) => path !== candidate.root_path));
                }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-text">{candidate.name}</span>
                  <span className="block truncate text-xs text-muted">{candidate.root_path}</span>
                  <span className="block text-[10px] text-muted">{candidate.files.length} files</span>
                </span>
              </label>
            ))}
          </div>
        )}
        <ErrorNote message={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="rounded-input border border-border px-3 py-1.5 text-ui-caption text-muted hover:bg-surface-2" onClick={onClose}>{t("common.cancel")}</button>
          <button type="button" disabled={busy || selected.length === 0} onClick={() => void confirmImport()} className="flex min-h-9 items-center gap-1.5 rounded-input bg-accent px-3 text-ui-caption text-white disabled:opacity-50">
            {busy && <Loader2 size={12} className="animate-spin" />}
            {t("skills.githubImport")}
          </button>
        </div>
      </div>
    </DialogShell>
  );
}

export function SkillChatDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const prompt = t("skills.chatPrompt");
  if (!open) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
    } catch { /* clipboard unavailable */ }
  };
  return (
    <DialogShell title={t("skills.chatTitle")} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-ui-body text-muted">{t("skills.chatDescription")}</p>
        <pre className="max-h-64 overflow-auto rounded-input bg-surface-2 p-3 text-xs text-text whitespace-pre-wrap">{prompt}</pre>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => void copy()} className="flex min-h-9 items-center gap-1.5 rounded-input border border-border px-3 text-ui-caption text-text hover:bg-surface-2">
            <Copy size={12} />
            {copied ? t("skills.copied") : t("skills.copy")}
          </button>
          <button type="button" onClick={onClose} className="rounded-input bg-accent px-3 py-1.5 text-ui-caption text-white">{t("common.close")}</button>
        </div>
      </div>
    </DialogShell>
  );
}