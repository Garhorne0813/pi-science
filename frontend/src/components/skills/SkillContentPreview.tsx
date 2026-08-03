import { useState } from "react";
import { AlertTriangle, FileText, Loader2, RotateCcw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { MarkdownViewer } from "../markdown-viewer/MarkdownViewer";
import { skillsApi, skillContentKey, type SkillContent } from "../../lib/skills/skills-api";

const FRONT_MATTER = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

/**
 * Read-only SKILL.md preview for a skill. The content is fetched lazily
 * (only when this component mounts, i.e. the SKILL.md tab is opened) and
 * keyed by skill id + workspace so switching skills or workspaces never
 * shows stale content. There is intentionally no editing surface here.
 */
export function SkillContentPreview({ skillId, cwd }: { skillId: string; cwd?: string }) {
  const { t } = useTranslation();
  const [reloadKey, setReloadKey] = useState(0);
  const query = useQuery({
    queryKey: [...skillContentKey(skillId, cwd ?? null), reloadKey],
    queryFn: () => skillsApi.content<SkillContent>(skillId, cwd),
    enabled: Boolean(skillId),
    retry: false,
  });

  if (query.isPending) {
    return (
      <div className="flex items-center gap-2 py-4 text-xs text-muted" aria-live="polite">
        <Loader2 size={13} className="animate-spin" /> {t("common.loading")}
      </div>
    );
  }
  if (query.isError) {
    return (
      <div role="alert" className="mt-3 flex items-center gap-2 rounded-input px-3 py-2 text-xs text-error" style={{ background: "color-mix(in srgb, var(--error) 10%, transparent)" }}>
        <AlertTriangle size={13} className="shrink-0" />
        <span className="flex-1">{t("skills.previewError")}</span>
        <button
          type="button"
          onClick={() => setReloadKey((key) => key + 1)}
          className="flex items-center gap-1 rounded-input border border-border px-2 py-1 text-text hover:bg-surface-2"
        >
          <RotateCcw size={11} /> {t("skills.retry")}
        </button>
      </div>
    );
  }
  const data = query.data;
  const match = data?.content.match(FRONT_MATTER);
  const body = match && data ? data.content.slice(match[0].length) : (data?.content ?? "");
  if (!data || body.trim() === "") {
    return <div className="py-4 text-xs text-muted">{t("skills.emptyContent")}</div>;
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[10px] text-muted">
        <FileText size={11} className="shrink-0" />
        <span className="truncate font-mono">{data.location}</span>
        <span className="ml-auto shrink-0 font-mono">{data.digest}</span>
      </div>
      {match ? (
        <details className="overflow-hidden rounded-input border border-border">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text">{t("skills.frontMatter")}</summary>
          <pre className="max-h-64 overflow-auto border-t border-faint p-3 font-mono text-[11px] leading-5" style={{ background: "color-mix(in srgb, var(--surface-2) 50%, transparent)" }}>{match[1]}</pre>
        </details>
      ) : null}
      <div className="max-h-[60vh] overflow-y-auto rounded-input border border-border p-3">
        <MarkdownViewer variant="chat">{body}</MarkdownViewer>
      </div>
    </div>
  );
}
