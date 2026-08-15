import { useEffect, useState } from "react";
import { FileText, Loader2, Lock, Save, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/ui";
import { fileInspectorForPath } from "../../lib/artifacts";
import { formatFileSize, projectKnowledgeApi, useLogicalFileViews, type ProjectPolicy } from "../../lib/knowledge";
import { useUiStore } from "../../lib/ui";

export function FilesTab({
  cwd,
  policy,
  onPolicyChange,
  onError,
}: {
  cwd: string;
  policy: ProjectPolicy | null;
  onPolicyChange: (policy: ProjectPolicy) => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const openInspector = useUiStore((state) => state.openInspector);
  const [view, setView] = useState<"by_type" | "by_topic" | "by_month">("by_type");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [lockedPaths, setLockedPaths] = useState(policy?.locked_paths.join("\n") ?? "");
  const [namingPattern, setNamingPattern] = useState(policy?.naming_pattern ?? "");
  const [saving, setSaving] = useState(false);

  // This tab only renders while it is selected, so the query is the lazy load the page
  // used to do by hand; knowledge writes invalidate it in place of the `files = null` reset.
  const viewsRead = useLogicalFileViews(cwd);
  const views = viewsRead.data ?? null;
  const loadError = viewsRead.error;
  useEffect(() => {
    if (loadError) onError(loadError instanceof Error ? loadError.message : t("knowledge.fileViewsError"));
  }, [loadError, onError, t]);

  useEffect(() => {
    setLockedPaths(policy?.locked_paths.join("\n") ?? "");
    setNamingPattern(policy?.naming_pattern ?? "");
  }, [policy]);

  const savePolicy = async () => {
    setSaving(true);
    onError(null);
    try {
      const updated = await projectKnowledgeApi.updatePolicy(cwd, {
        locked_paths: lockedPaths.split("\n").map((value) => value.trim()).filter(Boolean),
        naming_pattern: namingPattern,
      });
      onPolicyChange(updated);
      setSettingsOpen(false);
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : t("knowledge.filePolicyError"));
    } finally {
      setSaving(false);
    }
  };

  if (!views) return <div className="flex items-center justify-center py-16 text-muted"><Loader2 size={20} className="animate-spin" /></div>;
  const groups = views[view];
  return (
    <div className="space-y-4">
      <div className="ui-card-flat flex flex-col gap-3 rounded-card p-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1">
          {(["by_type", "by_topic", "by_month"] as const).map((value) => (
            <button key={value} type="button" onClick={() => setView(value)} className={cn("min-h-11 rounded-input px-3 py-2 text-sm", view === value ? "bg-surface-2 font-medium text-text" : "text-muted hover:text-text")}>
              {value === "by_type" ? t("knowledge.byType") : value === "by_topic" ? t("knowledge.byTopic") : t("knowledge.byMonth")}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setSettingsOpen((value) => !value)} className="flex min-h-11 items-center gap-1.5 rounded-input border border-border px-3 py-2 text-sm text-muted hover:text-text"><Settings size={14} /> {t("knowledge.policy")}</button>
        </div>
      </div>

      {settingsOpen && policy && (
        <section className="ui-card-flat rounded-card p-5">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-text"><Lock size={16} className="text-accent" /> {t("knowledge.organizationPolicy")}</h2>
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <label className="text-xs font-medium text-muted">
              {t("knowledge.lockedPaths")}
              <textarea value={lockedPaths} onChange={(event) => setLockedPaths(event.target.value)} rows={5} placeholder="data/raw&#10;deliverables/final" className="mt-1 w-full rounded-input border border-border bg-bg px-3 py-2 font-mono text-sm leading-6 text-text outline-none focus:border-accent" />
            </label>
            <label className="text-xs font-medium text-muted">
              {t("knowledge.namingPattern")}
              <input value={namingPattern} onChange={(event) => setNamingPattern(event.target.value)} className="mt-1 min-h-11 w-full rounded-input border border-border bg-bg px-3 py-2 font-mono text-sm text-text outline-none focus:border-accent" />
              <span className="mt-2 block font-normal leading-5">{t("knowledge.policyHint", { depth: policy.max_directory_depth, count: policy.minimum_files_for_new_category })}</span>
            </label>
          </div>
          <div className="mt-4 flex justify-end">
            <button type="button" disabled={saving} onClick={() => void savePolicy()} className="flex min-h-11 items-center gap-2 rounded-input bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50">{saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} {t("knowledge.savePolicy")}</button>
          </div>
        </section>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {Object.entries(groups).sort(([a], [b]) => a.localeCompare(b)).map(([group, rows]) => (
          <section key={group} className="ui-card-flat overflow-hidden rounded-card">
            <div className="flex items-center justify-between border-b border-faint px-4 py-3">
              <h2 className="truncate text-sm font-semibold text-text">{group}</h2>
              <span className="font-mono text-xs text-muted">{rows.length}</span>
            </div>
            <div className="divide-y divide-faint">
              {rows.slice(0, 40).map((file) => (
                <button key={file.id} type="button" onClick={() => openInspector(fileInspectorForPath(file.path, file.name, undefined, cwd))} className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2">
                  <FileText size={15} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate text-sm text-text">{file.path}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted">{formatFileSize(file.size)}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
