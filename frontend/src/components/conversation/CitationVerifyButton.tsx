import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useCitationCwd, useVerifyCitation } from "../../lib/citations/citation-evidence";
import { cn } from "../../lib/ui";

/** Check one named source. The action never widens to the sources around it,
 *  and it works whether or not automatic verification is on: turning the
 *  automatic switch off stops background work, not a reader's own request. */
export function CitationVerifyButton({ citationKey, hasEvidence, className }: { citationKey: string; hasEvidence: boolean; className?: string }) {
  const { t } = useTranslation();
  const cwd = useCitationCwd();
  const verify = useVerifyCitation(cwd);
  const [error, setError] = useState("");
  const run = async () => {
    setError("");
    try { await verify.mutateAsync({ ids: [citationKey], refresh: hasEvidence }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        disabled={verify.isPending || !cwd}
        onClick={() => void run()}
        className={cn("rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[10px] text-text hover:border-accent hover:text-accent disabled:opacity-50", className)}
      >
        {verify.isPending ? t("conversation.citationState.checking") : hasEvidence ? t("citation.card.reverify") : t("citation.card.verify")}
      </button>
      {error && <span role="alert" className="text-[10px] text-error-text">{t("conversation.citationVerifyFailed", { reason: error })}</span>}
    </span>
  );
}
