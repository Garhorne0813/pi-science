import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, GitBranch, Check, AlertTriangle } from "lucide-react";
import { cn } from "../../lib/ui";
import { WorkspacePage, WorkspacePageHeader, WorkspacePageRefreshButton } from "../../components/layout/WorkspacePage";
import { useTranslation } from "react-i18next";
import { listArtifacts, groupArtifacts, type ArtifactLibraryEntry } from "../../lib/artifacts/artifact-library";
import type { ArtifactClassification } from "../../lib/artifacts/artifact-lineage";
import { useRequiredWorkspaceCwd } from "../../lib/workspace";

export function artifactLibraryKey(cwd: string) {
  return ["artifact-library", cwd];
}

type ClassificationFilter = "all" | "deliverable" | "intermediate" | "unspecified";

/** Project-level Artifact Library: every artifact grouped by identity with
 *  version history, classification and review verdicts (4.1). */
export function ArtifactsPage() {
  const { t } = useTranslation();
  const cwd = useRequiredWorkspaceCwd();
  const [filter, setFilter] = useState<ClassificationFilter>("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const result = useQuery({
    queryKey: artifactLibraryKey(cwd),
    queryFn: () => listArtifacts(cwd),
  });
  const loading = result.isFetching;

  const entries = useMemo(() => {
    const grouped = groupArtifacts(result.data ?? []);
    if (filter === "all") return grouped;
    return grouped.filter((entry) => entry.latest.classification === filter);
  }, [result.data, filter]);

  const toggle = (id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] }));

  return (
    <WorkspacePage>
      <WorkspacePageHeader
        title={t("artifacts.title")}
        description={t("artifacts.count", { count: entries.length })}
        actions={<WorkspacePageRefreshButton label={t("common.refresh")} loading={loading} onClick={() => void result.refetch()} />}
      />
      <div className="mt-4 flex items-center gap-1.5 text-xs">
        {(["all", "deliverable", "intermediate", "unspecified"] as ClassificationFilter[]).map((value) => (
          <button
            key={value}
            onClick={() => setFilter(value)}
            className={cn("rounded-full px-2.5 py-1", filter === value ? "bg-accent/15 text-accent" : "text-muted hover:bg-surface-2")}
          >
            {classificationFilterLabel(value, t)}
          </button>
        ))}
      </div>
      <div className="mt-4 flex flex-col gap-2">
        {loading && entries.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted"><Loader2 size={18} className="mx-auto mb-2 animate-spin" /> {t("common.loading")}</div>
        ) : entries.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted">{t("artifacts.empty")}</div>
        ) : (
          entries.map((entry) => <ArtifactEntryRow key={entry.artifact_id} entry={entry} expanded={Boolean(expanded[entry.artifact_id])} onToggle={() => toggle(entry.artifact_id)} />)
        )}
      </div>
    </WorkspacePage>
  );
}

function ArtifactEntryRow({ entry, expanded, onToggle }: { entry: ArtifactLibraryEntry; expanded: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const { latest, versions } = entry;
  return (
    <div className="rounded-lg border border-border bg-surface-1/50">
      <button onClick={onToggle} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <GitBranch size={14} className="shrink-0 text-accent" />
        <span className="truncate font-mono text-xs">{latest.path}</span>
        <span className="shrink-0 rounded bg-surface-2 px-1.5 py-px text-[10px] text-muted">{versions.length} v</span>
        <span className={cn("shrink-0 rounded bg-surface-2 px-1.5 py-px text-[10px]", classificationTone(latest.classification))}>{artifactClassificationLabel(latest.classification, t)}</span>
        {entry.latestReview && (
          <span className={cn("shrink-0 rounded px-1.5 py-px text-[10px]", entry.latestReview.status === "passed" ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn")}>
            {entry.latestReview.status === "passed" ? <Check size={10} className="inline" /> : <AlertTriangle size={10} className="inline" />}
            {reviewLabel(entry.latestReview.status, t)}
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-border px-3 py-2">
          <div className="flex flex-col gap-1">
            {versions.map((version) => (
              <div key={version.version} className="flex items-center gap-2 text-[11px]">
                <span className="w-8 shrink-0 font-mono text-muted">v{version.version}</span>
                <span className="truncate text-muted">{version.sha256.slice(0, 8)}</span>
                <span className="shrink-0 text-muted">{formatBytes(version.size)}</span>
                <span className="ml-auto shrink-0 text-muted opacity-70">{version.published_at.slice(0, 10)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function classificationTone(classification: string): string {
  return classification === "deliverable" ? "text-ok" : classification === "intermediate" ? "text-accent" : "text-muted";
}

function classificationFilterLabel(value: ClassificationFilter, t: (key: string) => string): string {
  switch (value) {
    case "all": return t("artifacts.filter.all");
    case "deliverable": return t("artifacts.filter.deliverable");
    case "intermediate": return t("artifacts.filter.intermediate");
    case "unspecified": return t("artifacts.filter.unspecified");
  }
}

function artifactClassificationLabel(value: ArtifactClassification, t: (key: string) => string): string {
  switch (value) {
    case "deliverable": return t("artifacts.classification.deliverable");
    case "intermediate": return t("artifacts.classification.intermediate");
    case "unspecified": return t("artifacts.classification.unspecified");
  }
}

function reviewLabel(status: "passed" | "failed" | "needs_work", t: (key: string) => string): string {
  switch (status) {
    case "passed": return t("artifacts.review.passed");
    case "failed": return t("artifacts.review.failed");
    case "needs_work": return t("artifacts.review.needs_work");
  }
}

function formatBytes(size: number): string {
  if (size < 1024) return size + " B";
  if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
  return (size / (1024 * 1024)).toFixed(1) + " MB";
}
