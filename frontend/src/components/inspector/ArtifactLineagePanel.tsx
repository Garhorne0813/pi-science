import { GitBranch, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useArtifactLineage, type ArtifactClassification } from "../../lib/artifacts/artifact-lineage";
import { fileInspectorForPath } from "../../lib/artifacts/artifacts";
import { useUiStore } from "../../lib/ui";
import { useRuntimeStore } from "../../lib/agent-runtime";

/** Versioned lineage of the file currently open in the inspector: exact input
 *  versions it consumes, the version it supersedes, and every dependent
 *  artifact. Legacy string inputs are shown as unresolved — they never form a
 *  DAG edge. Renders nothing when the file has no artifact manifest or the
 *  lineage endpoint is unavailable, so ordinary file history is not crowded.
 *
 *  When `artifactId`/`version` are provided the lineage is pinned to that
 *  EXACT version (relation jumps); otherwise the path is resolved to its
 *  latest manifest. Relation clicks open a version-aware inspector: the
 *  preview still shows current bytes but History/lineage select the exact
 *  version, so the click never pretends the live file is that version. */
export function ArtifactLineagePanel({ path, cwd: cwdOverride, artifactId, version }: { path: string; cwd?: string; artifactId?: string; version?: number }) {
  const { t } = useTranslation();
  const runtimeCwd = useRuntimeStore((s) => s.cwd);
  const cwd = cwdOverride || runtimeCwd;
  const openInspector = useUiStore((s) => s.openInspector);
  const query = useArtifactLineage(cwd, path, artifactId, version);

  if (query.isLoading) {
    return (
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-muted">
        <Loader2 size={12} className="animate-spin" /> {t("lineage.loading")}
      </div>
    );
  }
  if (!query.data?.ok) return null;

  const { artifact, upstream, downstream, unresolved_inputs } = query.data.data;
  const openVersionedFile = (target: { path: string; artifact_id: string; version: number }) => {
    const inspector = fileInspectorForPath(target.path, undefined, "workspace", cwd, { artifact_id: target.artifact_id, version: target.version });
    openInspector({ ...inspector, cwd } as never);
  };

  return (
    <div className="border-b border-border px-3 py-2.5">
      <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted">
        <GitBranch size={12} className="text-accent" />
        {t("lineage.title")}
        <span className="rounded bg-surface-2 px-1.5 py-px font-mono text-[10px] text-text">
          v{artifact.version}
        </span>
        <span className={`rounded bg-surface-2 px-1.5 py-px text-[10px] ${classificationTone(artifact.classification)}`}>
          {classificationLabel(artifact.classification, t)}
        </span>
      </div>

      {upstream.length > 0 && (
        <LineageGroup title={t("lineage.inputs")}>
          {upstream.map((entry) => (
            <LineageRow key={`${entry.kind}:${entry.artifact.artifact_id}:${entry.artifact.version}`} path={entry.artifact.path} version={entry.artifact.version} tone={entry.kind === "supersedes" ? "warn" : "default"} title={entry.kind === "supersedes" ? t("lineage.supersedes") : t("lineage.consumes")} onClick={() => openVersionedFile(entry.artifact)} />
          ))}
        </LineageGroup>
      )}

      {downstream.length > 0 && (
        <LineageGroup title={t("lineage.dependents")}>
          {downstream.map((entry) => (
            <LineageRow key={`${entry.kind}:${entry.artifact.artifact_id}:${entry.artifact.version}`} path={entry.artifact.path} version={entry.artifact.version} tone={entry.kind === "superseded_by" ? "warn" : "default"} title={entry.kind === "superseded_by" ? t("lineage.supersededBy") : t("lineage.consumedBy")} onClick={() => openVersionedFile(entry.artifact)} />
          ))}
        </LineageGroup>
      )}

      {unresolved_inputs.length > 0 && (
        <LineageGroup title={t("lineage.unresolved")}>
          {unresolved_inputs.map((input) => (
            <span key={input} className="block truncate font-mono text-[11px] text-muted opacity-70" title={t("lineage.unresolvedTitle")}>
              {input}
            </span>
          ))}
        </LineageGroup>
      )}
    </div>
  );
}

function LineageGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted opacity-70">{title}</div>
      <div className="mt-0.5 flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

function LineageRow({ path, version, tone, title, onClick }: { path: string; version: number; tone: "default" | "warn"; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="flex min-w-0 items-center gap-1.5 rounded-input px-1.5 py-0.5 text-left hover:bg-surface-2"
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-text">{path}</span>
      <span className={`shrink-0 rounded bg-surface-2 px-1 font-mono text-[10px] ${tone === "warn" ? "text-warn" : "text-muted"}`}>v{version}</span>
    </button>
  );
}

function classificationLabel(classification: ArtifactClassification, t: (key: string) => string): string {
  switch (classification) {
    case "intermediate": return t("lineage.classification.intermediate");
    case "deliverable": return t("lineage.classification.deliverable");
    default: return t("lineage.classification.unspecified");
  }
}

function classificationTone(classification: ArtifactClassification): string {
  switch (classification) {
    case "intermediate": return "text-warn";
    case "deliverable": return "text-ok";
    default: return "text-muted";
  }
}
