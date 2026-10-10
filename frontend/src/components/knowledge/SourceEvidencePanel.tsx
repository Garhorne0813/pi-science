import { useTranslation } from "react-i18next";
import type { SourceReference } from "../../lib/knowledge";

export function SourceEvidencePanel({ source }: { source: SourceReference }) {
  const { t } = useTranslation();
  const evidence = source.evidence ?? [];
  const empty = !source.session_id && !source.message_ids.length && !source.files.length
    && !source.run_ids.length && !source.citations.length && !evidence.length;
  return <div className="mt-2 space-y-2 break-all text-xs text-muted">
    {source.session_id && <div>{t("knowledge.sourceSession")}: <span className="font-mono">{source.session_id}</span></div>}
    {source.message_ids.map((id, index) => <div key={`message-${index}`}>{t("knowledge.sourceMessage")}: <span className="font-mono">{id}</span></div>)}
    {source.files.map((file, index) => <div key={`file-${index}`}>{t("knowledge.sourceFile")}: <span className="font-mono">{file}</span></div>)}
    {source.run_ids.map((id, index) => <div key={`run-${index}`}>{t("knowledge.sourceRun")}: <span className="font-mono">{id}</span></div>)}
    {source.citations.map((citation, index) => <div key={`citation-${index}`}>{citation}</div>)}
    {evidence.map((entry, index) => <div key={`evidence-${index}`} className="rounded-input bg-surface-2 p-2">
      <div><span>{entry.kind}: </span><span className="font-mono">{entry.locator}</span>{entry.line_start != null && <span>:{entry.line_start}{entry.line_end != null && entry.line_end !== entry.line_start ? `–${entry.line_end}` : ""}</span>}</div>
      {entry.excerpt && <p className="mt-1 whitespace-pre-wrap">{entry.excerpt}</p>}
    </div>)}
    {empty && "—"}
  </div>;
}
