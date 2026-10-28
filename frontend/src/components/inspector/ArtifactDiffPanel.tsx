import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ArtifactDiff } from "@/lib/artifacts/artifact-versions";
import { fetchArtifactDiff } from "@/lib/artifacts/artifact-versions";
import { previewUrl } from "@/lib/files";
import { cn } from "@/lib/ui";
import type { FileRoot } from "@/types/thread";

/**
 * Structured diff between the published artifact version being inspected and
 * its previous version: unified hunks for text and code, cell-level changes
 * for tables, side-by-side images, and an honest "unsupported" note for the
 * rest. All bytes come from immutable published content, never the live file.
 */
export function ArtifactDiffPanel({
  cwd,
  artifactId,
  toVersion,
  root,
  path,
}: {
  cwd: string;
  artifactId: string;
  toVersion: number;
  root?: FileRoot;
  path: string;
}) {
  const { t } = useTranslation();
  const [diff, setDiff] = useState<ArtifactDiff | null | "failed">(null);

  useEffect(() => {
    let cancelled = false;
    setDiff(null);
    void fetchArtifactDiff(cwd, artifactId, toVersion - 1, toVersion).then((result) => {
      if (!cancelled) setDiff(result ?? "failed");
    });
    return () => { cancelled = true; };
  }, [cwd, artifactId, toVersion]);

  if (diff === null) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-muted">
        <Loader2 size={15} className="animate-spin" /> {t("diff.loading")}
      </div>
    );
  }
  if (diff === "failed") return <div className="p-4 text-sm text-muted">{t("diff.unavailable")}</div>;

  const versionLabel = `${t("diff.versionPair", { from: diff.from_version, to: diff.to_version })}`;

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center gap-2 text-sm text-text">
        <span className="font-medium">{versionLabel}</span>
        {diff.kind !== "unsupported" && diff.kind !== "image" && diff.truncated && (
          <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-muted">{t("diff.truncated")}</span>
        )}
      </div>

      {diff.kind === "unsupported" && <div className="text-sm text-muted">{t("diff.unsupportedKind", { reason: diff.reason })}</div>}

      {diff.kind === "image" && (
        <div className="grid grid-cols-2 gap-3">
          {[
            { sha: diff.from_sha256, label: t("diff.previousVersion", { version: diff.from_version }) },
            { sha: diff.to_sha256, label: t("diff.currentVersion", { version: diff.to_version }) },
          ].map((side) => (
            <figure key={side.sha} className="space-y-1">
              <img
                src={previewUrl(path, root, cwd, side.sha)}
                alt={side.label}
                className="max-h-80 w-full rounded-input border border-border object-contain bg-surface-2"
              />
              <figcaption className="text-center text-xs text-muted">{side.label}</figcaption>
            </figure>
          ))}
        </div>
      )}

      {diff.kind === "table" && (
        <div className="space-y-3">
          <p className="text-xs text-muted">
            {t("diff.tableSummary", { added: diff.rows_added, removed: diff.rows_removed, cells: diff.cells.length })}
          </p>
          {diff.cells.length > 0 && (
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-border text-muted">
                  <th className="py-1 pr-3 font-medium">{t("diff.row")}</th>
                  <th className="py-1 pr-3 font-medium">{t("diff.column")}</th>
                  <th className="py-1 pr-3 font-medium">{t("diff.before")}</th>
                  <th className="py-1 font-medium">{t("diff.after")}</th>
                </tr>
              </thead>
              <tbody>
                {diff.cells.map((cell, index) => (
                  <tr key={`${cell.row}:${cell.column}:${index}`} className="border-b border-border/60">
                    <td className="py-1 pr-3 text-muted">{cell.row}</td>
                    <td className="py-1 pr-3 font-mono text-text">{cell.column}</td>
                    <td className="py-1 pr-3 font-mono text-error-text">{cell.from || "—"}</td>
                    <td className="py-1 font-mono text-ok-text">{cell.to || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <details>
            <summary className="cursor-pointer text-xs text-muted">{t("diff.showLineDiff")}</summary>
            <div className="mt-2">{diff.hunks.map((hunk, index) => <HunkView key={index} hunk={hunk} />)}</div>
          </details>
        </div>
      )}

      {diff.kind === "text" && (
        <div className="space-y-3">
          {diff.hunks.length === 0 && <div className="text-sm text-muted">{t("diff.noChanges")}</div>}
          {diff.hunks.map((hunk, index) => <HunkView key={index} hunk={hunk} />)}
        </div>
      )}
    </div>
  );
}

function HunkView({ hunk }: { hunk: { header: string; lines: Array<{ type: " " | "-" | "+"; text: string }> } }) {
  return (
    <div className="overflow-hidden rounded-input border border-border">
      <div className="bg-surface-2 px-3 py-1 font-mono text-xs text-muted">{hunk.header}</div>
      <pre className="overflow-x-auto p-0 font-mono text-xs leading-5">
        {hunk.lines.map((line, index) => (
          <div
            key={index}
            className={cn(
              "whitespace-pre px-3",
              line.type === "-" && "bg-error-fill/40 text-error-text",
              line.type === "+" && "bg-ok-fill/40 text-ok-text",
              line.type === " " && "text-muted",
            )}
          >
            <span className="mr-2 inline-block w-2 select-none text-muted">{line.type === " " ? "" : line.type}</span>
            {line.text || "\u00A0"}
          </div>
        ))}
      </pre>
    </div>
  );
}
