import { useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import { useTranslation } from "react-i18next";

import { projectKnowledgeApi, type Proposal } from "../../lib/knowledge";
import { EmptyState } from "./EmptyState";
import { ProposalCard } from "./ProposalCard";

export function InboxTab({
  cwd,
  proposals,
  onDecide,
  onUpdate,
  onChanged,
  onMessage,
  onError,
}: {
  cwd: string;
  proposals: Proposal[];
  onDecide: (proposal: Proposal, action: "accept" | "reject", edits?: Partial<Proposal>) => Promise<void>;
  onUpdate: (proposal: Proposal, changes: Partial<Proposal>) => Promise<void>;
  onChanged: () => Promise<void>;
  onMessage: (message: string) => void;
  onError: (message: string | null) => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // A reload can retract proposals; the selection keeps only ids that are still pending.
  useEffect(() => {
    const valid = new Set(proposals.map((proposal) => proposal.id));
    setSelected((current) => {
      const kept = [...current].filter((id) => valid.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [proposals]);

  const batch = async (action: "accept" | "reject") => {
    if (selected.size === 0) return;
    onError(null);
    try {
      const result = await projectKnowledgeApi.batch(cwd, [...selected], action);
      if (result.failures.length) {
        onError(result.failures.map((failure) => `${failure.proposal_id}: ${failure.detail}`).join("\n"));
      } else {
        onMessage(action === "accept" ? t("knowledge.acceptedBatch") : t("knowledge.rejectedBatch"));
      }
      setSelected(new Set());
      await onChanged();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : t("knowledge.batchError"));
    }
  };

  const allSelected = proposals.length > 0 && proposals.every((proposal) => selected.has(proposal.id));
  if (proposals.length === 0) {
    return <EmptyState icon={<Inbox size={28} />} title={t("knowledge.inboxEmpty")} text={t("knowledge.inboxEmptyText")} />;
  }
  return (
    <div>
      <div className="ui-card-flat mb-4 flex flex-col gap-3 rounded-card p-3 sm:flex-row sm:items-center sm:justify-between">
        <label className="flex min-h-11 cursor-pointer items-center gap-2 px-1 text-sm text-text">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={(event) => setSelected(event.target.checked ? new Set(proposals.map((proposal) => proposal.id)) : new Set())}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          {t("knowledge.selectAll")} ({selected.size}/{proposals.length})
        </label>
        <div className="flex gap-2">
          <button type="button" disabled={selected.size === 0} onClick={() => void batch("reject")} className="min-h-11 rounded-input border border-border px-3 py-2 text-sm text-muted hover:border-error/40 hover:text-error-text disabled:cursor-not-allowed disabled:opacity-40">
            {t("knowledge.rejectSelected")}
          </button>
          <button type="button" disabled={selected.size === 0} onClick={() => void batch("accept")} className="min-h-11 rounded-input bg-accent-fill px-3 py-2 text-sm font-medium text-accent-fg hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40">
            {t("knowledge.acceptSelected")}
          </button>
        </div>
      </div>
      <div className="space-y-4">
        {proposals.map((proposal) => (
          <ProposalCard
            key={proposal.id}
            cwd={cwd}
            proposal={proposal}
            selected={selected.has(proposal.id)}
            onSelect={(value) => setSelected((current) => {
              const next = new Set(current);
              if (value) next.add(proposal.id); else next.delete(proposal.id);
              return next;
            })}
            onDecide={onDecide}
            onUpdate={onUpdate}
          />
        ))}
      </div>
    </div>
  );
}
